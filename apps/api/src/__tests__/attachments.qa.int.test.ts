/**
 * M10-7 QA gap-fill — attachment API integration tests covering the plan §6
 * cases the M10-3 suite did not pin. Same pattern as attachments.int.test.ts:
 * real Postgres from docker-compose + an injected mock storage (never the live
 * bucket). Additive only — the M10-3 suite is untouched.
 *
 * Gaps covered here:
 * - `complete` rejects when the REAL stored object size exceeds the per-kind
 *   cap (a client that declared a small size then uploaded a big file).
 * - Re-sign endpoint authz: a non-member asking for another group's channel
 *   URLs gets the same 404 as a missing channel (no existence leak).
 * - PATCH edit response retains `attachments[]` (an edit must never drop a
 *   message's attachments from the client's copy).
 * - Duplicate ids in one `/urls` batch are de-duplicated (one signed URL each).
 * - upload-url rate limit: 30/min per session, the 31st answers RATE_LIMITED.
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

  async createSignedUploadUrl(path: string): Promise<SignedUpload> {
    return {
      uploadUrl: `https://mock.storage/upload/${encodeURIComponent(path)}?token=t`,
      expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
    };
  }
  async createSignedReadUrl(path: string, ttlSeconds: number): Promise<SignedRead> {
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
  console.warn("[attachments.qa.int.test] DATABASE unreachable — skipping integration tests");
}

describe.skipIf(!dbUp)("M10-7 attachment API QA gaps", () => {
  let client: DbClient;
  let app: FastifyInstance;
  let storage: MockStorage;

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const password = "correct-horse-9";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  let ownerToken: string;
  let strangerToken: string;
  let rateToken: string;

  let textChannelId: string;
  let rateChannelId: string;

  async function register(username: string) {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username, password, displayName: username },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { token: string; user: { id: string } };
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
    storage = new MockStorage();
    app = await buildApp({
      repos: createRepositories(client.db),
      env: loadEnv({ DATABASE_URL }),
      storage,
      logger: false,
    });

    const owner = await register(`qa_own_${suffix}`);
    const stranger = await register(`qa_str_${suffix}`);
    const rateUser = await register(`qa_rate_${suffix}`);
    ownerToken = owner.token;
    strangerToken = stranger.token;
    rateToken = rateUser.token;

    const group = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(ownerToken),
      payload: { name: "QA Crew" },
    });
    const groupId = group.json().group.id as string;
    const channel = await app.inject({
      method: "POST",
      url: `/groups/${groupId}/channels`,
      headers: auth(ownerToken),
      payload: { name: "qa-general", kind: "text" },
    });
    expect(channel.statusCode).toBe(201);
    textChannelId = channel.json().channel.id as string;

    // The rate-limit user needs its own group+channel (session-keyed limiter,
    // 31 calls — keep it off the owner's bucket and channel entirely).
    const rateGroup = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(rateToken),
      payload: { name: "QA Rate Crew" },
    });
    const rateChannel = await app.inject({
      method: "POST",
      url: `/groups/${rateGroup.json().group.id as string}/channels`,
      headers: auth(rateToken),
      payload: { name: "qa-rate", kind: "text" },
    });
    expect(rateChannel.statusCode).toBe(201);
    rateChannelId = rateChannel.json().channel.id as string;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("rejects complete when the REAL stored object exceeds the per-kind cap (400)", async () => {
    // Client declares an in-cap size to get the signed URL…
    const signed = await uploadUrl(ownerToken, textChannelId, {
      mime: "image/png",
      sizeBytes: 2048,
    });
    expect(signed.statusCode).toBe(201);
    const attachmentId = signed.json().attachmentId as string;

    // …then actually uploads 11 MB (image cap is 10 MB). Valid PNG bytes, so
    // only the authoritative size re-check can catch the lie.
    storage.probe = { exists: true, sizeBytes: 11 * 1024 * 1024, head: PNG_HEAD };
    const done = await app.inject({
      method: "POST",
      url: `/attachments/${attachmentId}/complete`,
      headers: auth(ownerToken),
      payload: {},
    });
    expect(done.statusCode).toBe(400);
    expect(done.json().error.code).toBe("INVALID_ATTACHMENT");
    storage.resetProbe();

    // The attachment must stay pending — it cannot be linked to a message.
    const send = await app.inject({
      method: "POST",
      url: `/channels/${textChannelId}/messages`,
      headers: auth(ownerToken),
      payload: { content: "sneaky", attachmentIds: [attachmentId] },
    });
    expect(send.statusCode).toBe(400);
    expect(send.json().error.code).toBe("INVALID_ATTACHMENT");
  });

  it("re-sign endpoint answers 404 to a non-member (no channel existence leak)", async () => {
    const attachmentId = await readyImage(ownerToken, textChannelId);

    const res = await app.inject({
      method: "POST",
      url: `/channels/${textChannelId}/attachments/urls`,
      headers: auth(strangerToken),
      payload: { attachmentIds: [attachmentId] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    // Nothing about the attachment (or the channel) leaks in the body.
    expect(JSON.stringify(res.json())).not.toContain(attachmentId);
  });

  it("keeps attachments[] on the PATCH edit response (edit never drops tiles)", async () => {
    const attachmentId = await readyImage(ownerToken, textChannelId);
    const created = await app.inject({
      method: "POST",
      url: `/channels/${textChannelId}/messages`,
      headers: auth(ownerToken),
      payload: { content: "before edit", attachmentIds: [attachmentId] },
    });
    expect(created.statusCode).toBe(201);
    const messageId = created.json().message.id as string;

    const edited = await app.inject({
      method: "PATCH",
      url: `/messages/${messageId}`,
      headers: auth(ownerToken),
      payload: { content: "after edit" },
    });
    expect(edited.statusCode).toBe(200);
    const message = edited.json().message as {
      content: string;
      attachments?: Array<{ id: string; messageId: string | null }>;
    };
    expect(message.content).toBe("after edit");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments?.[0]?.id).toBe(attachmentId);
    expect(message.attachments?.[0]?.messageId).toBe(messageId);
    expect(JSON.stringify(edited.json())).not.toContain("storagePath");
  });

  it("de-duplicates repeated ids in one /urls batch (one signed URL per id)", async () => {
    const attachmentId = await readyImage(ownerToken, textChannelId);
    const res = await app.inject({
      method: "POST",
      url: `/channels/${textChannelId}/attachments/urls`,
      headers: auth(ownerToken),
      payload: { attachmentIds: [attachmentId, attachmentId, attachmentId] },
    });
    expect(res.statusCode).toBe(200);
    const urls = res.json().urls as Array<{ attachmentId: string }>;
    expect(urls).toHaveLength(1);
    expect(urls[0]?.attachmentId).toBe(attachmentId);
  });

  it("rate-limits upload-url at 30/min per session (31st → 429 RATE_LIMITED)", async () => {
    // Sequential on purpose: the limiter must see one ordered sequence. All 30
    // are legitimate signed-upload requests on the user's own channel.
    for (let i = 0; i < 30; i += 1) {
      const res = await uploadUrl(rateToken, rateChannelId, {
        mime: "image/png",
        sizeBytes: 1024,
      });
      expect(res.statusCode).toBe(201);
    }
    const blocked = await uploadUrl(rateToken, rateChannelId, {
      mime: "image/png",
      sizeBytes: 1024,
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("RATE_LIMITED");

    // A different session is untouched — the limiter is per-session, not global.
    const other = await uploadUrl(ownerToken, textChannelId, {
      mime: "image/png",
      sizeBytes: 1024,
    });
    expect(other.statusCode).toBe(201);
  });
});
