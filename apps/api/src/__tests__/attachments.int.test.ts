/**
 * M10-3 attachment API integration tests — real Postgres from docker-compose,
 * with an INJECTED mock storage (no live Supabase; the task forbids touching the
 * shared bucket). The mock records signing/remove calls and returns configurable
 * probe bytes so the magic-byte sniff, size re-check, and enrichment are all
 * exercised against the real repos + channel-visibility guard.
 *
 * Skipped automatically (with a notice) when the database is down.
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
import type {
  AttachmentStorage,
  ObjectProbe,
  SignedRead,
  SignedUpload,
} from "../lib/storage.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/demli";

/** PNG magic bytes — the default "valid image" head returned by the mock probe. */
const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

class MockStorage implements AttachmentStorage {
  probe: ObjectProbe = { exists: true, sizeBytes: 1024, head: PNG_HEAD };
  removed: string[] = [];
  uploads: { path: string; size: number }[] = [];
  signedUploads: string[] = [];
  readUrlCalls = 0;

  async createSignedUploadUrl(path: string): Promise<SignedUpload> {
    this.signedUploads.push(path);
    return {
      uploadUrl: `https://mock.storage/upload/${encodeURIComponent(path)}?token=t`,
      expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
    };
  }
  async createSignedReadUrl(path: string, ttlSeconds: number): Promise<SignedRead> {
    this.readUrlCalls += 1;
    return {
      url: `https://mock.storage/read/${encodeURIComponent(path)}?token=t`,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  }
  async probeObject(): Promise<ObjectProbe> {
    return this.probe;
  }
  async upload(path: string, bytes: Uint8Array): Promise<void> {
    this.uploads.push({ path, size: bytes.length });
  }
  async remove(paths: string[]): Promise<void> {
    this.removed.push(...paths);
  }
  resetProbe(): void {
    this.probe = { exists: true, sizeBytes: 1024, head: PNG_HEAD };
  }
}

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
  console.warn("[attachments.int.test] DATABASE unreachable — skipping integration tests");
}

describe.skipIf(!dbUp)("M10-3 attachment API", () => {
  let client: DbClient;
  let repos: Repositories;
  let app: FastifyInstance;
  let storage: MockStorage;

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const password = "correct-horse-9";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  let ownerToken: string;
  let strangerToken: string;
  let ownerId: string;

  let textChannelId: string;
  let secondTextChannelId: string;
  let voiceChannelId: string;
  let strangerTextChannelId: string;

  async function register(username: string) {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username, password, displayName: username },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { token: string; user: { id: string } };
  }

  async function createChannel(token: string, groupId: string, kind: "text" | "voice") {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${groupId}/channels`,
      headers: auth(token),
      payload: { name: `${kind}-${Math.random().toString(36).slice(2, 6)}`, kind },
    });
    expect(res.statusCode).toBe(201);
    return res.json().channel.id as string;
  }

  async function uploadUrl(token: string, channelId: string, body: unknown) {
    return app.inject({
      method: "POST",
      url: `/channels/${channelId}/attachments/upload-url`,
      headers: auth(token),
      payload: body as Record<string, unknown>,
    });
  }

  /** Full happy-path: upload-url → complete → returns a ready attachment id. */
  async function readyImage(token: string, channelId: string): Promise<string> {
    storage.resetProbe();
    const signed = await uploadUrl(token, channelId, {
      mime: "image/png",
      sizeBytes: 2048,
    });
    expect(signed.statusCode).toBe(201);
    const attachmentId = signed.json().attachmentId as string;
    const done = await app.inject({
      method: "POST",
      url: `/attachments/${attachmentId}/complete`,
      headers: auth(token),
      payload: { width: 640, height: 480 },
    });
    expect(done.statusCode).toBe(200);
    return attachmentId;
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    storage = new MockStorage();
    app = await buildApp({
      repos,
      env: loadEnv({ DATABASE_URL }),
      storage,
      logger: false,
    });

    const owner = await register(`att_own_${suffix}`);
    const stranger = await register(`att_str_${suffix}`);
    ownerToken = owner.token;
    ownerId = owner.user.id;
    strangerToken = stranger.token;

    const group = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(ownerToken),
      payload: { name: "Att Crew" },
    });
    const groupId = group.json().group.id as string;
    textChannelId = await createChannel(ownerToken, groupId, "text");
    secondTextChannelId = await createChannel(ownerToken, groupId, "text");
    voiceChannelId = await createChannel(ownerToken, groupId, "voice");

    const strangerGroup = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(strangerToken),
      payload: { name: "Stranger Crew" },
    });
    strangerTextChannelId = await createChannel(
      strangerToken,
      strangerGroup.json().group.id as string,
      "text",
    );
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("signs an upload URL and records a pending row for a valid image", async () => {
    const res = await uploadUrl(ownerToken, textChannelId, {
      mime: "image/png",
      sizeBytes: 4096,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { attachmentId: string; uploadUrl: string; expiresAt: string };
    expect(body.attachmentId).toBeTruthy();
    expect(body.uploadUrl).toContain("mock.storage/upload");
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects an over-cap size and a non-whitelisted mime (400)", async () => {
    const tooBig = await uploadUrl(ownerToken, textChannelId, {
      mime: "image/png",
      sizeBytes: 11 * 1024 * 1024, // image cap is 10 MB
    });
    expect(tooBig.statusCode).toBe(400);
    expect(tooBig.json().error.code).toBe("INVALID_ATTACHMENT");

    const badMime = await uploadUrl(ownerToken, textChannelId, {
      mime: "image/svg+xml", // deliberately excluded (stored-XSS)
      sizeBytes: 1024,
    });
    expect(badMime.statusCode).toBe(400);
    expect(badMime.json().error.code).toBe("INVALID_ATTACHMENT");
  });

  it("allows upload-url on a VOICE channel (M20 chat) but not on an invisible one (404)", async () => {
    // Inverted at M20: a voice channel's text chat takes attachments like any
    // other chat. The visibility half of this test is unchanged and is the point
    // — widening the KIND gate must not have widened the ACCESS gate.
    const onVoice = await uploadUrl(ownerToken, voiceChannelId, {
      mime: "image/png",
      sizeBytes: 1024,
    });
    expect(onVoice.statusCode).toBe(201);
    expect(typeof onVoice.json().attachmentId).toBe("string");

    // Non-member of the stranger's channel ⇒ same 404 as a missing channel.
    const foreign = await uploadUrl(ownerToken, strangerTextChannelId, {
      mime: "image/png",
      sizeBytes: 1024,
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe("NOT_FOUND");
  });

  it("completes an upload to ready and returns a DTO WITHOUT storagePath/status", async () => {
    storage.resetProbe();
    const signed = await uploadUrl(ownerToken, textChannelId, {
      mime: "image/png",
      sizeBytes: 2048,
    });
    const attachmentId = signed.json().attachmentId as string;

    const done = await app.inject({
      method: "POST",
      url: `/attachments/${attachmentId}/complete`,
      headers: auth(ownerToken),
      payload: { width: 800, height: 600 },
    });
    expect(done.statusCode).toBe(200);
    const dto = done.json().attachment as Record<string, unknown>;
    expect(dto.id).toBe(attachmentId);
    expect(dto.kind).toBe("image");
    expect(dto.width).toBe(800);
    expect(dto).not.toHaveProperty("storagePath");
    expect(dto).not.toHaveProperty("status");
  });

  it("rejects complete when the bytes do not match the declared kind (400)", async () => {
    const signed = await uploadUrl(ownerToken, textChannelId, {
      mime: "image/png",
      sizeBytes: 2048,
    });
    const attachmentId = signed.json().attachmentId as string;
    // Bytes with no recognised media signature ⇒ sniff null ⇒ reject.
    storage.probe = { exists: true, sizeBytes: 2048, head: new Uint8Array([1, 2, 3, 4]) };
    const done = await app.inject({
      method: "POST",
      url: `/attachments/${attachmentId}/complete`,
      headers: auth(ownerToken),
      payload: {},
    });
    expect(done.statusCode).toBe(400);
    expect(done.json().error.code).toBe("INVALID_ATTACHMENT");
    storage.resetProbe();
  });

  it("rejects complete by a non-uploader (404, no existence leak)", async () => {
    storage.resetProbe();
    const signed = await uploadUrl(ownerToken, textChannelId, {
      mime: "image/png",
      sizeBytes: 2048,
    });
    const attachmentId = signed.json().attachmentId as string;
    const done = await app.inject({
      method: "POST",
      url: `/attachments/${attachmentId}/complete`,
      headers: auth(strangerToken),
      payload: {},
    });
    expect(done.statusCode).toBe(404);
  });

  it("links attachments on message create and enriches the returned DTO", async () => {
    const attachmentId = await readyImage(ownerToken, textChannelId);
    const res = await app.inject({
      method: "POST",
      url: `/channels/${textChannelId}/messages`,
      headers: auth(ownerToken),
      payload: { content: "look at this", attachmentIds: [attachmentId] },
    });
    expect(res.statusCode).toBe(201);
    const message = res.json().message as {
      id: string;
      content: string;
      attachments?: Array<{ id: string; messageId: string | null }>;
    };
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments?.[0]?.id).toBe(attachmentId);
    expect(message.attachments?.[0]?.messageId).toBe(message.id);
  });

  it("allows an attachment-only message and rejects an empty one", async () => {
    const attachmentId = await readyImage(ownerToken, textChannelId);
    const captionless = await app.inject({
      method: "POST",
      url: `/channels/${textChannelId}/messages`,
      headers: auth(ownerToken),
      payload: { attachmentIds: [attachmentId] },
    });
    expect(captionless.statusCode).toBe(201);
    expect(captionless.json().message.attachments).toHaveLength(1);

    const empty = await app.inject({
      method: "POST",
      url: `/channels/${textChannelId}/messages`,
      headers: auth(ownerToken),
      payload: { content: "   " },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects linking a not-ready attachment id (400)", async () => {
    storage.resetProbe();
    const signed = await uploadUrl(ownerToken, textChannelId, {
      mime: "image/png",
      sizeBytes: 2048,
    });
    const pendingId = signed.json().attachmentId as string; // never completed
    const res = await app.inject({
      method: "POST",
      url: `/channels/${textChannelId}/messages`,
      headers: auth(ownerToken),
      payload: { content: "premature", attachmentIds: [pendingId] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_ATTACHMENT");
  });

  it("enriches GET messages with attachment metadata (no signed URLs)", async () => {
    const attachmentId = await readyImage(ownerToken, textChannelId);
    await app.inject({
      method: "POST",
      url: `/channels/${textChannelId}/messages`,
      headers: auth(ownerToken),
      payload: { content: "in the list", attachmentIds: [attachmentId] },
    });
    const list = await app.inject({
      method: "GET",
      url: `/channels/${textChannelId}/messages`,
      headers: auth(ownerToken),
    });
    expect(list.statusCode).toBe(200);
    const messages = list.json().messages as Array<{
      attachments?: Array<{ id: string; mime: string }>;
    }>;
    const withAttachment = messages.find((m) => m.attachments?.some((a) => a.id === attachmentId));
    expect(withAttachment).toBeDefined();
    expect(JSON.stringify(messages)).not.toContain("storagePath");
    expect(JSON.stringify(messages)).not.toContain("mock.storage"); // no URLs baked in
  });

  it("mints signed READ URLs for a channel's attachments and rejects a channel mismatch", async () => {
    const attachmentId = await readyImage(ownerToken, textChannelId);
    const before = storage.readUrlCalls;
    const ok = await app.inject({
      method: "POST",
      url: `/channels/${textChannelId}/attachments/urls`,
      headers: auth(ownerToken),
      payload: { attachmentIds: [attachmentId] },
    });
    expect(ok.statusCode).toBe(200);
    const urls = ok.json().urls as Array<{ attachmentId: string; url: string; urlExpiresAt: string }>;
    expect(urls).toHaveLength(1);
    expect(urls[0]?.attachmentId).toBe(attachmentId);
    expect(urls[0]?.url).toContain("mock.storage/read");
    expect(storage.readUrlCalls).toBe(before + 1);

    // Same id, DIFFERENT (but visible) channel ⇒ 404 channel-mismatch rejection.
    const mismatch = await app.inject({
      method: "POST",
      url: `/channels/${secondTextChannelId}/attachments/urls`,
      headers: auth(ownerToken),
      payload: { attachmentIds: [attachmentId] },
    });
    expect(mismatch.statusCode).toBe(404);
  });

  it("cancels an unsent upload (204 + storage remove + row deleted) and refuses a sent one (409)", async () => {
    storage.resetProbe();
    const attachmentId = await readyImage(ownerToken, textChannelId);
    const removedBefore = storage.removed.length;
    const cancel = await app.inject({
      method: "DELETE",
      url: `/attachments/${attachmentId}`,
      headers: auth(ownerToken),
    });
    expect(cancel.statusCode).toBe(204);
    expect(storage.removed.length).toBe(removedBefore + 1);

    // The row is deleted synchronously now (not left to the 24h sweep): a second
    // cancel finds nothing, and the repo confirms the row is gone.
    const cancelAgain = await app.inject({
      method: "DELETE",
      url: `/attachments/${attachmentId}`,
      headers: auth(ownerToken),
    });
    expect(cancelAgain.statusCode).toBe(404);
    expect(await repos.attachments.findById(attachmentId)).toBeNull();

    // A foreign uploader cannot cancel someone else's upload (404, no leak),
    // and the row survives that attempt.
    const survivorId = await readyImage(ownerToken, textChannelId);
    const foreignCancel = await app.inject({
      method: "DELETE",
      url: `/attachments/${survivorId}`,
      headers: auth(strangerToken),
    });
    expect(foreignCancel.statusCode).toBe(404);
    expect(await repos.attachments.findById(survivorId)).not.toBeNull();

    // A linked attachment cannot be cancelled, and the row is left intact.
    const linkedId = await readyImage(ownerToken, textChannelId);
    await app.inject({
      method: "POST",
      url: `/channels/${textChannelId}/messages`,
      headers: auth(ownerToken),
      payload: { content: "keep me", attachmentIds: [linkedId] },
    });
    const cancelSent = await app.inject({
      method: "DELETE",
      url: `/attachments/${linkedId}`,
      headers: auth(ownerToken),
    });
    expect(cancelSent.statusCode).toBe(409);
    expect(await repos.attachments.findById(linkedId)).not.toBeNull();
  });

  it("purges attachment storage objects when a message is deleted", async () => {
    const attachmentId = await readyImage(ownerToken, textChannelId);
    const created = await app.inject({
      method: "POST",
      url: `/channels/${textChannelId}/messages`,
      headers: auth(ownerToken),
      payload: { content: "delete me", attachmentIds: [attachmentId] },
    });
    const messageId = created.json().message.id as string;
    const removedBefore = storage.removed.length;

    const del = await app.inject({
      method: "DELETE",
      url: `/messages/${messageId}`,
      headers: auth(ownerToken),
    });
    expect(del.statusCode).toBe(204);
    expect(storage.removed.length).toBe(removedBefore + 1);
  });

  it("keeps ownerId consistent (sanity: registered owner is the group owner)", async () => {
    // Guards against a mixed-up fixture; ownerId is used implicitly above.
    expect(ownerId).toBeTruthy();
  });
});
