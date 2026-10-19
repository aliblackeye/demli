/**
 * Avatar / banner OWNERSHIP in the shared public bucket — unit tests over
 * mocked repos and a recording bucket (no DB, no Supabase).
 *
 * The attack (code-health-server sweep): every avatar/banner URL is public — it
 * rides the user DTO. Mallory sets HER avatarUrl to Alice's avatar URL, then
 * uploads a new avatar. The upload's "purge the previous object" step used to
 * trust any URL inside the bucket, so it deleted ALICE's file and Alice's avatar
 * 404'd for everyone. The same worked through bannerUrl, and against server
 * banners, because all of them share one bucket.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashSessionToken, type Repositories } from "@demli/db";
import type { User } from "@demli/types";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import { buildAvatarStoragePath } from "../lib/avatar-upload.js";
import { buildBannerStoragePath } from "../lib/banner-upload.js";
import { buildGroupBannerStoragePath } from "../lib/group-banner-upload.js";
import {
  avatarOwnerPrefix,
  bannerOwnerPrefix,
  bucketObjectPath,
  groupBannerOwnerPrefix,
  ownedObjectPath,
  type AvatarStorage,
} from "../lib/storage.js";

const BUCKET = "https://cdn.example/storage/v1/object/public/avatars/";

class RecordingBucket implements AvatarStorage {
  removed: string[] = [];
  uploads: string[] = [];
  async upload(path: string): Promise<void> {
    this.uploads.push(path);
  }
  async remove(paths: string[]): Promise<void> {
    this.removed.push(...paths);
  }
  publicUrl(path: string): string {
    return `${BUCKET}${path.split("/").map(encodeURIComponent).join("/")}`;
  }
}

const ALICE = "11111111-1111-4111-8111-111111111111";
const MALLORY = "22222222-2222-4222-8222-222222222222";
const SERVER = "33333333-3333-4333-8333-333333333333";
const MALLORY_TOKEN = "mallory-token";

const bucket = new RecordingBucket();
const aliceAvatar = bucket.publicUrl(`avatars/${ALICE}/aaaa.png`);
const aliceBanner = bucket.publicUrl(`banners/${ALICE}/bbbb.png`);

function pngBase64(): string {
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(8, 16);
  buf.writeUInt32BE(8, 20);
  return buf.toString("base64");
}

const rows = new Map<string, User & { bannerUrl: string | null }>();

function resetRows(): void {
  rows.clear();
  for (const [id, username] of [
    [ALICE, "alice"],
    [MALLORY, "mallory"],
  ] as const) {
    rows.set(id, {
      id,
      username,
      displayName: username,
      avatarUrl: null,
      bannerUrl: null,
      createdAt: new Date().toISOString(),
    } as User & { bannerUrl: string | null });
  }
}

const repos = {
  sessions: {
    findActiveByTokenHash: async (hash: string) =>
      hash === hashSessionToken(MALLORY_TOKEN)
        ? { session: { id: "s-mallory" }, user: rows.get(MALLORY) }
        : null,
    touchLastSeen: async () => undefined,
  },
  users: {
    findById: async (id: string) => rows.get(id) ?? null,
    findSelf: async (id: string) => rows.get(id) ?? null,
    updateProfile: async (id: string, patch: Record<string, unknown>) => {
      const row = rows.get(id);
      if (!row) return null;
      const next = { ...row, ...patch } as User & { bannerUrl: string | null };
      rows.set(id, next);
      return next;
    },
  },
} as unknown as Repositories;

describe("ownedObjectPath — ownership is the owner's key prefix, not the bucket", () => {
  it("accepts only keys under the owner's prefix", () => {
    expect(ownedObjectPath(aliceAvatar, bucket, avatarOwnerPrefix(ALICE))).toBe(
      `avatars/${ALICE}/aaaa.png`,
    );
    expect(ownedObjectPath(aliceAvatar, bucket, avatarOwnerPrefix(MALLORY))).toBeNull();
    expect(ownedObjectPath(aliceAvatar, bucket, bannerOwnerPrefix(ALICE))).toBeNull();
    expect(ownedObjectPath("https://lh3.googleusercontent.com/a/x", bucket, avatarOwnerPrefix(ALICE))).toBeNull();
    expect(ownedObjectPath(null, bucket, avatarOwnerPrefix(ALICE))).toBeNull();
    // The bare prefix is not an object.
    expect(ownedObjectPath(bucket.publicUrl(`avatars/${ALICE}/x`).slice(0, -1), bucket, avatarOwnerPrefix(ALICE))).toBeNull();
  });

  it("refuses keys that decode into traversal or extra separators", () => {
    const traversal = `${BUCKET}avatars/${MALLORY}/..%2F..%2Favatars/${ALICE}/aaaa.png`;
    expect(ownedObjectPath(traversal, bucket, avatarOwnerPrefix(MALLORY))).toBeNull();
    const dotdot = `${BUCKET}avatars/${MALLORY}/../${ALICE}/aaaa.png`;
    expect(ownedObjectPath(dotdot, bucket, avatarOwnerPrefix(MALLORY))).toBeNull();
    const encodedDots = `${BUCKET}avatars/${MALLORY}/%2E%2E/${ALICE}/aaaa.png`;
    expect(ownedObjectPath(encodedDots, bucket, avatarOwnerPrefix(MALLORY))).toBeNull();
    const backslash = `${BUCKET}avatars/${MALLORY}/..%5C${ALICE}/aaaa.png`;
    expect(ownedObjectPath(backslash, bucket, avatarOwnerPrefix(MALLORY))).toBeNull();
    expect(bucketObjectPath(`${BUCKET}avatars//x.png`, bucket)).toBeNull();
    expect(bucketObjectPath(`${BUCKET}avatars/%E0%A4%A/x.png`, bucket)).toBeNull();
  });

  it("every upload path lands under the prefix the purge checks", () => {
    expect(buildAvatarStoragePath(ALICE, "image/png").startsWith(avatarOwnerPrefix(ALICE))).toBe(true);
    expect(buildBannerStoragePath(ALICE, "image/png").startsWith(bannerOwnerPrefix(ALICE))).toBe(true);
    expect(
      buildGroupBannerStoragePath(SERVER, "image/png").startsWith(groupBannerOwnerPrefix(SERVER)),
    ).toBe(true);
  });
});

describe("profile images cannot be used to delete someone else's object", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      repos,
      env: loadEnv({ DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/demli" }),
      avatarStorage: bucket,
      logger: false,
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    resetRows();
    rows.get(ALICE)!.avatarUrl = aliceAvatar;
    rows.get(ALICE)!.bannerUrl = aliceBanner;
    bucket.removed = [];
    bucket.uploads = [];
  });

  const asMallory = { authorization: `Bearer ${MALLORY_TOKEN}` };

  it("PATCH refuses pointing avatarUrl / bannerUrl at another user's object", async () => {
    const avatar = await app.inject({
      method: "PATCH",
      url: "/users/me",
      headers: asMallory,
      payload: { avatarUrl: aliceAvatar },
    });
    expect(avatar.statusCode).toBe(400);
    expect(avatar.json().error.code).toBe("VALIDATION_ERROR");

    const banner = await app.inject({
      method: "PATCH",
      url: "/users/me",
      headers: asMallory,
      payload: { bannerUrl: aliceBanner },
    });
    expect(banner.statusCode).toBe(400);

    // A server banner is in the same bucket and just as off-limits.
    const serverBanner = await app.inject({
      method: "PATCH",
      url: "/users/me",
      headers: asMallory,
      payload: { avatarUrl: bucket.publicUrl(`group-banners/${SERVER}/cccc.png`) },
    });
    expect(serverBanner.statusCode).toBe(400);
    expect(rows.get(MALLORY)?.avatarUrl).toBeNull();
  });

  it("PATCH still accepts null, an external URL, and the caller's own object", async () => {
    for (const avatarUrl of [
      null,
      "https://lh3.googleusercontent.com/a/mallory",
      bucket.publicUrl(`avatars/${MALLORY}/mine.png`),
    ]) {
      const res = await app.inject({
        method: "PATCH",
        url: "/users/me",
        headers: asMallory,
        payload: { avatarUrl },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it("an upload never purges a foreign object already stored on the profile (pre-fix data)", async () => {
    // State an attacker could have reached before this fix shipped.
    rows.get(MALLORY)!.avatarUrl = aliceAvatar;
    rows.get(MALLORY)!.bannerUrl = aliceBanner;

    const avatar = await app.inject({
      method: "POST",
      url: "/users/me/avatar",
      headers: asMallory,
      payload: { mime: "image/png", dataBase64: pngBase64() },
    });
    expect(avatar.statusCode).toBe(200);
    const banner = await app.inject({
      method: "POST",
      url: "/users/me/banner",
      headers: asMallory,
      payload: { mime: "image/png", dataBase64: pngBase64() },
    });
    expect(banner.statusCode).toBe(200);

    expect(bucket.removed).toEqual([]);
    expect(rows.get(ALICE)?.avatarUrl).toBe(aliceAvatar);
  });

  it("an upload still purges the caller's OWN previous object", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/users/me/avatar",
      headers: asMallory,
      payload: { mime: "image/png", dataBase64: pngBase64() },
    });
    expect(first.statusCode).toBe(200);
    const firstPath = bucket.uploads[0]!;

    const second = await app.inject({
      method: "POST",
      url: "/users/me/avatar",
      headers: asMallory,
      payload: { mime: "image/png", dataBase64: pngBase64() },
    });
    expect(second.statusCode).toBe(200);
    expect(bucket.removed).toEqual([firstPath]);
  });
});
