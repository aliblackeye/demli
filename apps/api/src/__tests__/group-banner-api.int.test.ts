/**
 * Server-banner upload API integration tests (M20) — real Postgres, a mock PUBLIC
 * avatar bucket, injected moderator stubs. Skipped (with a notice) when the
 * database is down.
 *
 * Focus, in the order these things would actually hurt:
 *  - AUTHORIZATION: the owner may set a banner; a plain member may NOT. A server
 *    banner is pushed to every member's sidebar, so "who may change it" is the
 *    whole security surface of the feature.
 *  - the bytes are validated BEFORE storage (whitelist → cap → magic bytes →
 *    PIXEL BUDGET), so neither a smuggled SVG nor a decompression bomb reaches
 *    the public bucket;
 *  - the PATCH route cannot be used to point the banner at an unvalidated URL —
 *    that would make the byte checks above optional;
 *  - a server with NO banner keeps working exactly as before (the column is
 *    nullable and null is a first-class state, not an error);
 *  - OFF BY DEFAULT: with no avatar bucket the route answers 503, prod unchanged;
 *  - the NSFW seam runs pre-store and a `rejected` verdict stores nothing;
 *  - a successful upload persists the PUBLIC URL and purges the previous object.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyMigrations,
  createDb,
  createRepositories,
  type DbClient,
  type Repositories,
} from "@demli/db";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import type { AvatarStorage } from "../lib/storage.js";
import type { MediaModerator } from "../lib/media-moderation.js";
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
  console.warn("[group-banner-api.int.test] DATABASE unreachable — skipping integration tests");
}

/** A mock PUBLIC avatar bucket that records what the API asked it to do. */
class MockAvatarStorage implements AvatarStorage {
  uploads: { path: string; size: number; contentType: string }[] = [];
  removed: string[] = [];
  async upload(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.uploads.push({ path, size: bytes.length, contentType });
  }
  async remove(paths: string[]): Promise<void> {
    this.removed.push(...paths);
  }
  publicUrl(path: string): string {
    return `https://cdn.example/avatars-bucket/${path}`;
  }
}

/**
 * A real PNG: signature + an IHDR stating `width`×`height`, padded to `bytes`.
 * The dimensions are load-bearing — the pixel-budget guard reads them, and an
 * image that will not state its size is refused.
 */
function pngBase64(bytes = 128, width = 8, height = 8): string {
  const buf = Buffer.alloc(bytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
  buf.writeUInt32BE(13, 8); // IHDR chunk length
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString("base64");
}

/** A GIF that is tiny on the wire and enormous decoded — the classic bomb. */
function gifBombBase64(): string {
  const buf = Buffer.alloc(64);
  buf.write("GIF89a", 0, "ascii");
  buf.writeUInt16LE(60_000, 6); // width
  buf.writeUInt16LE(60_000, 8); // height — 3.6 gigapixels
  return buf.toString("base64");
}

function svgBase64(): string {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`).toString("base64");
}

const REJECT_MODERATOR: MediaModerator = {
  enabled: true,
  async check() {
    return { verdict: "rejected", nsfw: true, reason: "test rejection" };
  },
};

describe.skipIf(!dbUp)("server banner upload API", () => {
  let client: DbClient;
  let repos: Repositories;
  let app: FastifyInstance; // uploads enabled, default (skipped) moderator
  let disabledApp: FastifyInstance; // avatarStorage: null
  let rejectApp: FastifyInstance; // reject-everything moderator
  let storage: MockAvatarStorage;

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const password = "correct-horse-9";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  let ownerToken: string;
  let memberToken: string;
  let groupId: string;

  const uploadTo = (
    instance: FastifyInstance,
    payload: { mime: string; dataBase64: string },
    tk = ownerToken,
    gid = groupId,
  ) =>
    instance.inject({
      method: "POST",
      url: `/groups/${gid}/banner`,
      headers: auth(tk),
      payload,
    });

  const readGroup = async (tk = ownerToken, gid = groupId) => {
    const res = await app.inject({ method: "GET", url: "/groups", headers: auth(tk) });
    const groups = (res.json() as { groups: { id: string; bannerUrl?: string | null }[] }).groups;
    return groups.find((g) => g.id === gid);
  };

  const register = async (username: string): Promise<{ token: string; id: string }> => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username, password, displayName: username },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { token: string; user: { id: string } };
    return { token: body.token, id: body.user.id };
  };

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    storage = new MockAvatarStorage();
    const env = loadEnv({ DATABASE_URL });

    app = await buildApp({ repos, env, avatarStorage: storage, logger: false });
    disabledApp = await buildApp({ repos, env, avatarStorage: null, logger: false });
    rejectApp = await buildApp({
      repos,
      env,
      avatarStorage: storage,
      mediaModerator: REJECT_MODERATOR,
      logger: false,
    });

    const owner = await register(`gb_own_${suffix}`);
    const member = await register(`gb_mem_${suffix}`);
    ownerToken = owner.token;
    memberToken = member.token;

    const created = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(ownerToken),
      payload: { name: `Banner Server ${suffix}` },
    });
    expect(created.statusCode).toBe(201);
    groupId = (created.json() as { group: { id: string } }).group.id;

    // Put the second account in the server as a plain member.
    await repos.groups.addMember(groupId, member.id, "member");
  });

  afterAll(async () => {
    await app?.close();
    await disabledApp?.close();
    await rejectApp?.close();
    await client?.close();
  });

  // ── the default state ─────────────────────────────────────────────────────

  it("a server with no banner reads back bannerUrl null — not an error, not a blank string", async () => {
    const group = await readGroup();
    expect(group).toBeDefined();
    expect(group?.bannerUrl ?? null).toBeNull();
  });

  // ── authorization ─────────────────────────────────────────────────────────

  it("the OWNER may upload a banner", async () => {
    const res = await uploadTo(app, { mime: "image/png", dataBase64: pngBase64(200) });
    expect(res.statusCode).toBe(200);

    const group = (res.json() as { group: { id: string; bannerUrl: string } }).group;
    expect(group.id).toBe(groupId);
    expect(group.bannerUrl).toMatch(
      /^https:\/\/cdn\.example\/avatars-bucket\/group-banners\//,
    );

    // The DECODED bytes were uploaded, not the base64 text, under this group.
    const uploaded = storage.uploads.at(-1);
    expect(uploaded?.size).toBe(200);
    expect(uploaded?.contentType).toBe("image/png");
    expect(uploaded?.path.startsWith(`group-banners/${groupId}/`)).toBe(true);

    // Persisted for real — a fresh read shows the new URL.
    expect((await readGroup())?.bannerUrl).toBe(group.bannerUrl);
  });

  it("a plain MEMBER may not — 403, and nothing is stored", async () => {
    const before = storage.uploads.length;
    const res = await uploadTo(app, { mime: "image/png", dataBase64: pngBase64() }, memberToken);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
    expect(storage.uploads).toHaveLength(before);
  });

  it("a NON-member gets 404, never 403 — membership is not leaked", async () => {
    const outsider = await register(`gb_out_${suffix}`);
    const before = storage.uploads.length;
    const res = await uploadTo(
      app,
      { mime: "image/png", dataBase64: pngBase64() },
      outsider.token,
    );
    expect(res.statusCode).toBe(404);
    expect(storage.uploads).toHaveLength(before);
  });

  it("requires authentication", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${groupId}/banner`,
      payload: { mime: "image/png", dataBase64: pngBase64() },
    });
    expect(res.statusCode).toBe(401);
  });

  // ── byte validation ───────────────────────────────────────────────────────

  it("refuses an SVG smuggled in under a PNG label — nothing reaches the bucket", async () => {
    const before = storage.uploads.length;
    const res = await uploadTo(app, { mime: "image/png", dataBase64: svgBase64() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_GROUP_BANNER");
    expect(storage.uploads).toHaveLength(before);
  });

  it("refuses an SVG declared honestly (off the whitelist)", async () => {
    const res = await uploadTo(app, { mime: "image/svg+xml", dataBase64: svgBase64() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_GROUP_BANNER");
  });

  it("refuses a DECOMPRESSION BOMB: small on the wire, gigapixels decoded", async () => {
    const before = storage.uploads.length;
    const res = await uploadTo(app, { mime: "image/gif", dataBase64: gifBombBase64() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_GROUP_BANNER");
    expect(storage.uploads).toHaveLength(before);
  });

  it("refuses an image whose header will not state its size (a stub PNG)", async () => {
    // Signature + zeroed IHDR: passes the magic-byte check, states 0×0.
    const stub = Buffer.alloc(128);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(stub);
    const res = await uploadTo(app, {
      mime: "image/png",
      dataBase64: stub.toString("base64"),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_GROUP_BANNER");
  });

  it("accepts a large-but-legal image (inside the 64 MP budget)", async () => {
    const res = await uploadTo(app, {
      mime: "image/png",
      dataBase64: pngBase64(256, 4000, 3000), // 12 MP
    });
    expect(res.statusCode).toBe(200);
  });

  // ── the PATCH escape hatch must stay shut ─────────────────────────────────

  it("PATCH cannot POINT the banner at an arbitrary URL (that would skip byte checks)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/groups/${groupId}`,
      headers: auth(ownerToken),
      payload: { bannerUrl: "https://evil.example/huge.png" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_GROUP_BANNER");

    // The real banner is untouched.
    expect((await readGroup())?.bannerUrl).toMatch(/cdn\.example/);
  });

  it("PATCH bannerUrl:null REMOVES the banner and purges the object", async () => {
    // Ensure there is one to remove.
    const uploaded = await uploadTo(app, { mime: "image/png", dataBase64: pngBase64() });
    expect(uploaded.statusCode).toBe(200);
    const path = storage.uploads.at(-1)?.path;
    const removedBefore = storage.removed.length;

    const res = await app.inject({
      method: "PATCH",
      url: `/groups/${groupId}`,
      headers: auth(ownerToken),
      payload: { bannerUrl: null },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { group: { bannerUrl: string | null } }).group.bannerUrl).toBeNull();
    expect((await readGroup())?.bannerUrl ?? null).toBeNull();
    expect(storage.removed.slice(removedBefore)).toContain(path);
  });

  it("a plain member cannot remove the banner either", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/groups/${groupId}`,
      headers: auth(memberToken),
      payload: { bannerUrl: null },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── lifecycle ─────────────────────────────────────────────────────────────

  it("purges the PREVIOUS banner object on a subsequent upload", async () => {
    const first = await uploadTo(app, { mime: "image/png", dataBase64: pngBase64() });
    expect(first.statusCode).toBe(200);
    const firstPath = storage.uploads.at(-1)?.path;

    const removedBefore = storage.removed.length;
    const second = await uploadTo(app, { mime: "image/png", dataBase64: pngBase64() });
    expect(second.statusCode).toBe(200);
    expect(storage.removed.slice(removedBefore)).toContain(firstPath);
  });

  it("renaming the server does NOT touch its banner", async () => {
    const before = (await readGroup())?.bannerUrl;
    expect(before).toBeTruthy();
    const removedBefore = storage.removed.length;

    const res = await app.inject({
      method: "PATCH",
      url: `/groups/${groupId}`,
      headers: auth(ownerToken),
      payload: { name: `Renamed ${suffix}` },
    });
    expect(res.statusCode).toBe(200);
    expect((await readGroup())?.bannerUrl).toBe(before);
    expect(storage.removed).toHaveLength(removedBefore);
  });

  // ── feature gates ─────────────────────────────────────────────────────────

  it("answers 503 when no avatar bucket is configured (uploads off by default)", async () => {
    const res = await uploadTo(disabledApp, {
      mime: "image/png",
      dataBase64: pngBase64(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("GROUP_BANNER_UPLOADS_DISABLED");
  });

  it("a rejecting NSFW moderator 422s and stores nothing", async () => {
    const before = storage.uploads.length;
    const res = await uploadTo(rejectApp, { mime: "image/png", dataBase64: pngBase64() });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("GROUP_BANNER_REJECTED");
    expect(storage.uploads).toHaveLength(before);
  });
});
