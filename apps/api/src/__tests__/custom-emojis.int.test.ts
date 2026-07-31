/**
 * M17 — custom-emoji API integration tests. Real Postgres from docker-compose,
 * a mock storage backend (no live bucket), and an InMemoryMutationBus capturing
 * the group-scoped `emoji.created` / `emoji.deleted` fan-out.
 *
 * The focus is the LIMIT + VALIDATION surface, because that is where this
 * feature is dangerous:
 *  - the magic-byte sniff must reject a file whose real type disagrees with its
 *    declared MIME — that is the guard that stops an SVG (stored XSS) or a GIF
 *    being smuggled in as `image/png`;
 *  - the byte cap and the per-group count cap must hold;
 *  - the name grammar must be enforced and names must be unique per group,
 *    case-insensitively;
 *  - `storagePath` must never appear in any response.
 *
 * Skipped (with a notice) when the database is down.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyMigrations,
  createDb,
  createRepositories,
  InMemoryMutationBus,
  type DbClient,
  type RealtimeMutation,
  type Repositories,
} from "@demli/db";
import {
  CUSTOM_EMOJI_MAX_BYTES,
  CUSTOM_EMOJI_MAX_PER_GROUP,
} from "@demli/config";
import { SERVER_EVENT } from "@demli/protocol";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import type {
  AttachmentStorage,
  ObjectProbe,
  SignedRead,
  SignedUpload,
} from "../lib/storage.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/demli";

async function isDbUp(): Promise<boolean> {
  const { sql, close } = createDb(DATABASE_URL, { max: 1 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await close();
  }
}

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[custom-emojis.int.test] DATABASE unreachable — skipping integration tests");
}

/** Records what the API asked storage to do, so we can assert byte-level behaviour. */
class MockStorage implements AttachmentStorage {
  uploads: { path: string; size: number; contentType: string }[] = [];
  removed: string[] = [];

  async createSignedUploadUrl(path: string): Promise<SignedUpload> {
    return { uploadUrl: `https://mock/${path}`, expiresAt: new Date().toISOString() };
  }
  async createSignedReadUrl(path: string, ttlSeconds: number): Promise<SignedRead> {
    return {
      url: `https://mock/read/${encodeURIComponent(path)}`,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  }
  async probeObject(): Promise<ObjectProbe> {
    return { exists: true, sizeBytes: 0, head: new Uint8Array(0) };
  }
  async upload(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.uploads.push({ path, size: bytes.length, contentType });
  }
  async remove(paths: string[]): Promise<void> {
    this.removed.push(...paths);
  }
}

/**
 * A minimal but REAL png: the 8-byte signature plus an IHDR stating the size.
 *
 * The IHDR is load-bearing now that the emoji decoder carries the pixel-budget
 * guard the avatar/banner paths already had. A signature followed by filler is
 * NOT a valid image to that guard — a header that will not state its own
 * dimensions is exactly the shape a decompression bomb takes — so the fixture
 * has to be a real enough PNG to say how big it is.
 */
function pngBase64(bytes = 64, width = 8, height = 8): string {
  const buf = Buffer.alloc(bytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
  buf.writeUInt32BE(13, 8); // IHDR chunk length
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString("base64");
}

/** A real lossy WebP: `RIFF....WEBP` with a `VP8 ` frame stating the size. */
function webpBase64(width = 8, height = 8): string {
  const buf = Buffer.alloc(64);
  buf.write("RIFF", 0, "ascii");
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8 ", 12, "ascii");
  // The VP8 keyframe start code — without it a reader cannot tell a frame header
  // from arbitrary bytes and refuses to report a size at all.
  buf.writeUInt8(0x9d, 23);
  buf.writeUInt8(0x01, 24);
  buf.writeUInt8(0x2a, 25);
  buf.writeUInt16LE(width, 26);
  buf.writeUInt16LE(height, 28);
  return buf.toString("base64");
}

/** An SVG — the stored-XSS payload the sniff must refuse under a png label. */
function svgBase64(): string {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
  ).toString("base64");
}

/** A GIF header — excluded deliberately (animation cost), must not pass as png. */
function gifBase64(): string {
  const buf = Buffer.alloc(32);
  Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]).copy(buf);
  return buf.toString("base64");
}

interface EmojiDTO {
  id: string;
  groupId: string;
  name: string;
  mime: string;
  sizeBytes: number;
  createdBy: string;
  createdAt: string;
}

describe.skipIf(!dbUp)("M17 custom emoji API", () => {
  let client: DbClient;
  let app: FastifyInstance;
  let repos: Repositories;
  let storage: MockStorage;
  const bus = new InMemoryMutationBus();
  const published: RealtimeMutation[] = [];

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const password = "correct-horse-9";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  let ownerToken: string;
  let memberToken: string;
  let memberId: string;
  let outsiderToken: string;
  let groupId: string;

  async function register(username: string): Promise<{ token: string; id: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username, password, displayName: username },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { token: string; user: { id: string } };
    return { token: body.token, id: body.user.id };
  }

  const create = (
    token: string,
    payload: { name: string; mime: string; dataBase64: string },
    group = groupId,
  ) =>
    app.inject({
      method: "POST",
      url: `/groups/${group}/emojis`,
      headers: auth(token),
      payload,
    });

  const list = (token: string, group = groupId) =>
    app.inject({ method: "GET", url: `/groups/${group}/emojis`, headers: auth(token) });

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    storage = new MockStorage();
    await bus.subscribe((m) => published.push(m));

    app = await buildApp({
      repos,
      env: loadEnv({ DATABASE_URL }),
      mutationBus: bus,
      storage,
      logger: false,
    });

    const owner = await register(`emo_own_${suffix}`);
    ownerToken = owner.token;
    const group = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(ownerToken),
      payload: { name: "Emoji Crew" },
    });
    expect(group.statusCode).toBe(201);
    groupId = group.json().group.id as string;

    const member = await register(`emo_mem_${suffix}`);
    memberToken = member.token;
    memberId = member.id;
    const invite = await app.inject({
      method: "POST",
      url: `/groups/${groupId}/invites`,
      headers: auth(ownerToken),
      payload: {},
    });
    const join = await app.inject({
      method: "POST",
      url: `/invites/${invite.json().invite.code}/redeem`,
      headers: auth(memberToken),
    });
    expect(join.statusCode).toBe(200);

    const outsider = await register(`emo_out_${suffix}`);
    outsiderToken = outsider.token;
  });

  afterAll(async () => {
    await app?.close();
    await bus.close();
    await client?.close();
  });

  // --- happy path -----------------------------------------------------------

  it("uploads a png, stores the verified bytes, and fans emoji.created group-scoped", async () => {
    const before = storage.uploads.length;
    const res = await create(memberToken, {
      name: "party_cat",
      mime: "image/png",
      dataBase64: pngBase64(128),
    });
    expect(res.statusCode).toBe(201);

    const emoji = res.json().emoji as EmojiDTO;
    expect(emoji.name).toBe("party_cat");
    expect(emoji.createdBy).toBe(memberId);
    expect(emoji.sizeBytes).toBe(128);
    // The DECODED bytes were uploaded, not the base64 text.
    expect(storage.uploads[before]?.size).toBe(128);
    expect(storage.uploads[before]?.contentType).toBe("image/png");

    const event = published.find(
      (m) =>
        m.event.type === SERVER_EVENT.emojiCreated &&
        (m.event.payload as { emoji: EmojiDTO }).emoji.id === emoji.id,
    );
    expect(event?.groupId).toBe(groupId);
    expect(event?.channelId).toBeUndefined();
  });

  it("never returns storagePath (§28)", async () => {
    const res = await create(memberToken, {
      name: "no_path",
      mime: "image/png",
      dataBase64: pngBase64(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().emoji).not.toHaveProperty("storagePath");

    const listed = (await list(memberToken)).json().emojis as EmojiDTO[];
    for (const emoji of listed) expect(emoji).not.toHaveProperty("storagePath");
  });

  it("accepts webp", async () => {
    const res = await create(memberToken, {
      name: "webp_one",
      mime: "image/webp",
      dataBase64: webpBase64(),
    });
    expect(res.statusCode).toBe(201);
  });

  it("lowercases the name so :Cat: and :cat: are one emoji", async () => {
    const res = await create(memberToken, {
      name: "MixedCase",
      mime: "image/png",
      dataBase64: pngBase64(),
    });
    expect(res.statusCode).toBe(201);
    expect((res.json().emoji as EmojiDTO).name).toBe("mixedcase");

    const dupe = await create(memberToken, {
      name: "mixedcase",
      mime: "image/png",
      dataBase64: pngBase64(),
    });
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().error.code).toBe("EMOJI_NAME_TAKEN");
  });

  it("mints short-lived signed URLs through the batch endpoint", async () => {
    const created = await create(memberToken, {
      name: "url_me",
      mime: "image/png",
      dataBase64: pngBase64(),
    });
    const emojiId = (created.json().emoji as EmojiDTO).id;

    const res = await app.inject({
      method: "POST",
      url: `/groups/${groupId}/emojis/urls`,
      headers: auth(memberToken),
      payload: { emojiIds: [emojiId] },
    });
    expect(res.statusCode).toBe(200);
    const [url] = res.json().urls as { emojiId: string; url: string; urlExpiresAt: string }[];
    expect(url?.emojiId).toBe(emojiId);
    expect(url?.url).toContain("https://mock/read/");
    expect(new Date(url!.urlExpiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  // --- content validation (the security-critical part) ----------------------

  it("REJECTS an SVG declared as image/png (stored-XSS guard)", async () => {
    const before = storage.uploads.length;
    const res = await create(memberToken, {
      name: "sneaky_svg",
      mime: "image/png",
      dataBase64: svgBase64(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_EMOJI");
    // Nothing was written — the bytes are verified BEFORE storage.
    expect(storage.uploads).toHaveLength(before);
  });

  it("REJECTS a GIF declared as image/png (no-animation rule)", async () => {
    const res = await create(memberToken, {
      name: "sneaky_gif",
      mime: "image/png",
      dataBase64: gifBase64(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_EMOJI");
  });

  // The pixel bomb. A VALID png, comfortably under the 256 KB cap, whose IHDR
  // declares 60000x60000 — 3.6 gigapixels, ~14 GB of RGBA once decoded. Byte
  // caps do not bound this and never could. It matters most here of all the
  // upload paths: an emoji is decoded automatically by every client in the
  // channel the moment the message carrying it arrives, so one accepted upload
  // is a simultaneous renderer crash for everyone reading, triggered by any
  // non-guest member.
  it("REJECTS a small png declaring gigapixel dimensions (decompression bomb)", async () => {
    const before = storage.uploads.length;
    const res = await create(memberToken, {
      name: "pixel_bomb",
      mime: "image/png",
      dataBase64: pngBase64(128, 60_000, 60_000),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_EMOJI");
    // Verified BEFORE storage — the bytes never reach the bucket.
    expect(storage.uploads).toHaveLength(before);
  });

  // The other half of the same guard: a body that carries the right magic bytes
  // but no readable header at all. "Will not state its own size" is refused, not
  // waved through, or the check above would be one crafted header away from
  // being bypassed.
  it("REJECTS a png whose header states no dimensions", async () => {
    const headerless = Buffer.alloc(64);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(headerless);
    const res = await create(memberToken, {
      name: "no_ihdr",
      mime: "image/png",
      dataBase64: headerless.toString("base64"),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_EMOJI");
  });

  it("rejects a png declared as webp (declared type must match reality)", async () => {
    const res = await create(memberToken, {
      name: "wrong_type",
      mime: "image/webp",
      dataBase64: pngBase64(),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a MIME outside the whitelist (image/svg+xml)", async () => {
    const res = await create(memberToken, {
      name: "svg_mime",
      mime: "image/svg+xml",
      dataBase64: svgBase64(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_EMOJI");
  });

  it("enforces the byte cap", async () => {
    const res = await create(memberToken, {
      name: "too_big",
      mime: "image/png",
      dataBase64: pngBase64(CUSTOM_EMOJI_MAX_BYTES + 1),
    });
    expect([400, 413]).toContain(res.statusCode);
    expect(["EMOJI_TOO_LARGE", "VALIDATION_ERROR"]).toContain(res.json().error.code);
  });

  it("rejects names outside the grammar", async () => {
    for (const name of ["a", "has space", "Ünicode", "with-dash", "a".repeat(33), "co:lon"]) {
      const res = await create(memberToken, {
        name,
        mime: "image/png",
        dataBase64: pngBase64(),
      });
      expect(res.statusCode).toBe(400);
    }
  });

  // --- authorization --------------------------------------------------------

  it("answers 404 to a non-member — membership is not leaked", async () => {
    expect((await list(outsiderToken)).statusCode).toBe(404);
    const res = await create(outsiderToken, {
      name: "intruder",
      mime: "image/png",
      dataBase64: pngBase64(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("scopes emoji to their group — another group's id is 404", async () => {
    const otherGroup = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(ownerToken),
      payload: { name: "Other Crew" },
    });
    const otherGroupId = otherGroup.json().group.id as string;

    const mine = await create(memberToken, {
      name: "scoped",
      mime: "image/png",
      dataBase64: pngBase64(),
    });
    const emojiId = (mine.json().emoji as EmojiDTO).id;

    const res = await app.inject({
      method: "POST",
      url: `/groups/${otherGroupId}/emojis/urls`,
      headers: auth(ownerToken),
      payload: { emojiIds: [emojiId] },
    });
    expect(res.statusCode).toBe(404);
  });

  it("lets the uploader delete their own and purges the bytes", async () => {
    const created = await create(memberToken, {
      name: "delete_mine",
      mime: "image/png",
      dataBase64: pngBase64(),
    });
    const emojiId = (created.json().emoji as EmojiDTO).id;
    const before = storage.removed.length;

    const res = await app.inject({
      method: "DELETE",
      url: `/groups/${groupId}/emojis/${emojiId}`,
      headers: auth(memberToken),
    });
    expect(res.statusCode).toBe(204);
    expect(storage.removed.length).toBe(before + 1);

    const event = published.find(
      (m) =>
        m.event.type === SERVER_EVENT.emojiDeleted &&
        (m.event.payload as { emojiId: string }).emojiId === emojiId,
    );
    expect(event?.groupId).toBe(groupId);
  });

  it("lets the owner delete someone else's, but not a plain member", async () => {
    const created = await create(ownerToken, {
      name: "owners_one",
      mime: "image/png",
      dataBase64: pngBase64(),
    });
    const emojiId = (created.json().emoji as EmojiDTO).id;

    const refused = await app.inject({
      method: "DELETE",
      url: `/groups/${groupId}/emojis/${emojiId}`,
      headers: auth(memberToken),
    });
    expect(refused.statusCode).toBe(403);

    const allowed = await app.inject({
      method: "DELETE",
      url: `/groups/${groupId}/emojis/${emojiId}`,
      headers: auth(ownerToken),
    });
    expect(allowed.statusCode).toBe(204);
  });

  // --- per-group cap --------------------------------------------------------

  it("enforces CUSTOM_EMOJI_MAX_PER_GROUP with a 409", async () => {
    const capGroup = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(ownerToken),
      payload: { name: "Cap Crew" },
    });
    const capGroupId = capGroup.json().group.id as string;

    // Fill to the cap through the REPOSITORY, not the HTTP route. Uploading 64
    // emoji over HTTP would trip the per-session burst limiter and turn this
    // into a test of the limiter rather than of the cap. The 65th still goes
    // through the real endpoint, which is the assertion that matters.
    for (let i = 0; i < CUSTOM_EMOJI_MAX_PER_GROUP; i += 1) {
      const { emoji, error } = await repos.customEmojis.create({
        groupId: capGroupId,
        name: `e${i}`,
        mime: "image/png",
        sizeBytes: 64,
        storagePath: `emoji/${capGroupId}/seed-${i}.png`,
        createdBy: memberId,
      });
      expect(error).toBeNull();
      expect(emoji).not.toBeNull();
    }

    const overflow = await create(
      ownerToken,
      { name: "one_too_many", mime: "image/png", dataBase64: pngBase64() },
      capGroupId,
    );
    expect(overflow.statusCode).toBe(409);
    expect(overflow.json().error.code).toBe("EMOJI_LIMIT");

    const listed = (await list(ownerToken, capGroupId)).json();
    expect(listed.emojis).toHaveLength(CUSTOM_EMOJI_MAX_PER_GROUP);
    expect(listed.maxPerGroup).toBe(CUSTOM_EMOJI_MAX_PER_GROUP);
  });
});
