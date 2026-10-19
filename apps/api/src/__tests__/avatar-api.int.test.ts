/**
 * Avatar upload API integration tests — real Postgres, a mock PUBLIC avatar
 * bucket, and injected moderator stubs. Skipped (with a notice) when the database
 * is down.
 *
 * Focus (where this feature is dangerous / founder-visible):
 *  - the bytes are validated (whitelist → cap → magic bytes) BEFORE storage, so a
 *    smuggled SVG/GIF never reaches the public bucket;
 *  - OFF BY DEFAULT: with no avatar bucket the route answers 503, unchanged prod;
 *  - the server-side NSFW seam is bypass-proof (runs pre-store) and fail-open
 *    (a `skipped` verdict still uploads; a `rejected` verdict 422s and stores
 *    nothing);
 *  - a successful upload persists the PUBLIC URL onto the user and purges the
 *    previous object.
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
  console.warn("[avatar-api.int.test] DATABASE unreachable — skipping integration tests");
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
 * A real PNG: signature + an IHDR stating `width`x`height`, padded to `bytes`.
 * The dimensions are load-bearing — the pixel-budget guard reads them, so a
 * fixture of zeroed bytes behind a valid signature is refused like any other
 * image that will not state its own size.
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
function svgBase64(): string {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`).toString("base64");
}

const REJECT_MODERATOR: MediaModerator = {
  enabled: true,
  async check() {
    return { verdict: "rejected", nsfw: true, reason: "test rejection" };
  },
};

describe.skipIf(!dbUp)("avatar upload API", () => {
  let client: DbClient;
  let repos: Repositories;
  let app: FastifyInstance; // uploads enabled, default (skipped) moderator
  let disabledApp: FastifyInstance; // avatarStorage: null
  let rejectApp: FastifyInstance; // reject-everything moderator
  let storage: MockAvatarStorage;

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const password = "correct-horse-9";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  let token: string;
  let userId: string;

  const uploadTo = (
    instance: FastifyInstance,
    payload: { mime: string; dataBase64: string },
    tk = token,
  ) =>
    instance.inject({
      method: "POST",
      url: "/users/me/avatar",
      headers: auth(tk),
      payload,
    });

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

    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username: `av_${suffix}`, password, displayName: "Avatar Tester" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { token: string; user: { id: string } };
    token = body.token;
    userId = body.user.id;
  });

  afterAll(async () => {
    await app?.close();
    await disabledApp?.close();
    await rejectApp?.close();
    await client?.close();
  });

  it("uploads a png, stores the verified bytes, and persists the PUBLIC url on the user", async () => {
    const before = storage.uploads.length;
    const res = await uploadTo(app, { mime: "image/png", dataBase64: pngBase64(200) });
    expect(res.statusCode).toBe(200);

    const user = res.json().user as { id: string; avatarUrl: string | null };
    expect(user.id).toBe(userId);
    expect(user.avatarUrl).toMatch(/^https:\/\/cdn\.example\/avatars-bucket\/avatars\//);

    // The DECODED bytes were uploaded, not the base64 text, with the right type.
    const uploaded = storage.uploads[before];
    expect(uploaded?.size).toBe(200);
    expect(uploaded?.contentType).toBe("image/png");
    expect(uploaded?.path.startsWith(`avatars/${userId}/`)).toBe(true);

    // Persisted for real — a fresh read shows the new URL.
    const me = await app.inject({ method: "GET", url: "/users/me", headers: auth(token) });
    expect((me.json().user as { avatarUrl: string }).avatarUrl).toBe(user.avatarUrl);
  });

  it("purges the PREVIOUS avatar object on a subsequent upload", async () => {
    const first = await uploadTo(app, { mime: "image/png", dataBase64: pngBase64() });
    const firstPath = storage.uploads.at(-1)?.path;
    const firstUrl = (first.json().user as { avatarUrl: string }).avatarUrl;
    expect(firstUrl).toContain(firstPath);

    const removedBefore = storage.removed.length;
    const second = await uploadTo(app, { mime: "image/png", dataBase64: pngBase64() });
    expect(second.statusCode).toBe(200);
    // The old object (ours, in this bucket) was best-effort purged.
    expect(storage.removed.slice(removedBefore)).toContain(firstPath);
  });

  it("cannot point a profile at another user's object, so an upload cannot delete it", async () => {
    const victim = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username: `av_victim_${suffix}`, password, displayName: "Victim" },
    });
    const victimToken = (victim.json() as { token: string }).token;
    const victimUpload = await uploadTo(app, { mime: "image/png", dataBase64: pngBase64() }, victimToken);
    const victimUrl = (victimUpload.json().user as { avatarUrl: string }).avatarUrl;
    const victimPath = storage.uploads.at(-1)?.path;

    const hijack = await app.inject({
      method: "PATCH",
      url: "/users/me",
      headers: auth(token),
      payload: { avatarUrl: victimUrl },
    });
    expect(hijack.statusCode).toBe(400);

    const removedBefore = storage.removed.length;
    const upload = await uploadTo(app, { mime: "image/png", dataBase64: pngBase64() });
    expect(upload.statusCode).toBe(200);
    expect(storage.removed.slice(removedBefore)).not.toContain(victimPath);
  });

  it("answers 503 AVATAR_UPLOADS_DISABLED when no avatar bucket is configured", async () => {
    const res = await uploadTo(disabledApp, { mime: "image/png", dataBase64: pngBase64() });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("AVATAR_UPLOADS_DISABLED");
  });

  it("REJECTS an SVG declared as image/png BEFORE storing anything", async () => {
    const before = storage.uploads.length;
    const res = await uploadTo(app, { mime: "image/png", dataBase64: svgBase64() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_AVATAR");
    expect(storage.uploads).toHaveLength(before);
  });

  it("enforces the 2 MB cap", async () => {
    const res = await uploadTo(app, {
      mime: "image/png",
      dataBase64: pngBase64(2 * 1024 * 1024 + 1),
    });
    expect([400, 413]).toContain(res.statusCode);
    expect(["AVATAR_TOO_LARGE", "VALIDATION_ERROR"]).toContain(res.json().error.code);
  });

  it("blocks a rejected image (server-side NSFW seam) and stores nothing", async () => {
    const before = storage.uploads.length;
    const res = await uploadTo(rejectApp, { mime: "image/png", dataBase64: pngBase64() });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("AVATAR_REJECTED");
    expect(storage.uploads).toHaveLength(before);
  });

  it("requires auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/users/me/avatar",
      payload: { mime: "image/png", dataBase64: pngBase64() },
    });
    expect(res.statusCode).toBe(401);
  });
});
