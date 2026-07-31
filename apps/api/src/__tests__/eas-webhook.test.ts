/**
 * EAS Build webhook (task #39) — unit + route tests.
 *
 * Signature format verified 2026-07 against https://docs.expo.dev/eas/webhooks/
 * (HMAC-SHA1 over the raw body, `expo-signature: sha1=<hex>`). No live network
 * or real EAS: the download fetch is mocked, and the route's background
 * downloader is injected as a stub so scheduling is asserted without I/O.
 */

import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Repositories } from "@demli/db";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import {
  downloadApkToFile,
  FINAL_NAME,
  type DownloadApkOptions,
  type DownloadResult,
} from "../modules/hooks/download.js";
import { evaluateBuild, isAllowedArtifactUrl } from "../modules/hooks/payload.js";
import { verifyExpoSignature } from "../modules/hooks/signature.js";

const SECRET = "test-webhook-secret-0123456789ab"; // 32 chars (≥16 required)
const PREFIX = "https://expo.dev/artifacts/";
const APK_URL = `${PREFIX}eas/abc123.apk`;
const DB_URL = "postgresql://postgres:postgres@localhost:5432/demli";

function sign(body: string, secret = SECRET): string {
  return `sha1=${createHmac("sha1", secret).update(body).digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

describe("verifyExpoSignature", () => {
  const body = Buffer.from('{"id":"1"}');

  it("accepts a correct HMAC-SHA1 signature", () => {
    expect(verifyExpoSignature(body, sign(body.toString()), SECRET)).toBe(true);
  });

  it("rejects a wrong signature", () => {
    expect(verifyExpoSignature(body, "sha1=deadbeef", SECRET)).toBe(false);
    expect(verifyExpoSignature(body, sign(body.toString(), "other-secret-0123456789ab"), SECRET)).toBe(false);
  });

  it("rejects a missing / empty header", () => {
    expect(verifyExpoSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyExpoSignature(body, "", SECRET)).toBe(false);
  });

  it("rejects when the raw bytes differ (re-serialization would fail)", () => {
    const original = sign('{"a":1,"b":2}');
    expect(verifyExpoSignature(Buffer.from('{"b":2,"a":1}'), original, SECRET)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Build gating
// ---------------------------------------------------------------------------

describe("evaluateBuild", () => {
  const base = {
    id: "b1",
    platform: "android",
    status: "finished",
    artifacts: { buildUrl: APK_URL },
    metadata: { channel: "preview", distribution: "internal" },
  };

  it("processes a finished android apk build on an allowed channel", () => {
    expect(evaluateBuild(base)).toEqual({ process: true, buildUrl: APK_URL });
  });

  it("processes when no channel is present (internal APK may omit it)", () => {
    expect(evaluateBuild({ ...base, metadata: {} })).toEqual({ process: true, buildUrl: APK_URL });
    expect(evaluateBuild({ ...base, metadata: undefined })).toEqual({ process: true, buildUrl: APK_URL });
  });

  it("skips non-finished builds", () => {
    expect(evaluateBuild({ ...base, status: "errored" })).toMatchObject({ process: false, reason: "status:errored" });
    expect(evaluateBuild({ ...base, status: "canceled" })).toMatchObject({ process: false });
  });

  it("skips non-android builds", () => {
    expect(evaluateBuild({ ...base, platform: "ios" })).toMatchObject({ process: false, reason: "platform:ios" });
  });

  it("skips builds targeting a channel outside the allowlist", () => {
    expect(evaluateBuild({ ...base, metadata: { channel: "development" } })).toMatchObject({
      process: false,
      reason: "channel:development",
    });
  });

  it("skips a store AAB artifact (must not overwrite the APK)", () => {
    const aab = `${PREFIX}eas/abc123.aab`;
    expect(evaluateBuild({ ...base, metadata: { channel: "production" }, artifacts: { buildUrl: aab } })).toMatchObject({
      process: false,
      reason: "not-apk",
    });
  });

  it("skips when there is no artifact url", () => {
    expect(evaluateBuild({ ...base, artifacts: {} })).toMatchObject({ process: false, reason: "no-artifact-url" });
  });

  it("falls back to applicationArchiveUrl when buildUrl is absent", () => {
    expect(evaluateBuild({ ...base, artifacts: { applicationArchiveUrl: APK_URL } })).toEqual({
      process: true,
      buildUrl: APK_URL,
    });
  });
});

describe("isAllowedArtifactUrl", () => {
  it("accepts only the expo artifacts prefix", () => {
    expect(isAllowedArtifactUrl(APK_URL, PREFIX)).toBe(true);
    expect(isAllowedArtifactUrl("https://evil.example.com/x.apk", PREFIX)).toBe(false);
    expect(isAllowedArtifactUrl("http://expo.dev/artifacts/x.apk", PREFIX)).toBe(false); // http, not https
  });
});

// ---------------------------------------------------------------------------
// Streaming download + atomic write
// ---------------------------------------------------------------------------

describe("downloadApkToFile", () => {
  let dir: string;
  const bytes = Buffer.from("fake-apk-bytes");
  const okFetch = vi.fn(async () => new Response(bytes));

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "demli-apk-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    okFetch.mockClear();
  });

  it(`streams the artifact and atomically writes ${FINAL_NAME}`, async () => {
    const result = await downloadApkToFile({
      url: APK_URL,
      outputDir: dir,
      allowedPrefix: PREFIX,
      fetchImpl: okFetch as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true, bytes: bytes.length });
    expect(okFetch).toHaveBeenCalledWith(APK_URL);
    const written = await readFile(join(dir, FINAL_NAME));
    expect(written.equals(bytes)).toBe(true);
    // The temp file must not linger after a successful rename.
    await expect(stat(join(dir, `.${FINAL_NAME}.tmp`))).rejects.toThrow();
  });

  it("refuses a non-allowlisted URL without fetching (SSRF guard)", async () => {
    const result = await downloadApkToFile({
      url: "https://evil.example.com/x.apk",
      outputDir: dir,
      allowedPrefix: PREFIX,
      fetchImpl: okFetch as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: "forbidden-url" });
    expect(okFetch).not.toHaveBeenCalled();
  });

  it("aborts and cleans up when the artifact exceeds the size cap", async () => {
    const oversizeDir = await mkdtemp(join(tmpdir(), "demli-apk-big-"));
    const result = await downloadApkToFile({
      url: APK_URL,
      outputDir: oversizeDir,
      allowedPrefix: PREFIX,
      fetchImpl: (async () => new Response(Buffer.from("hello world"))) as unknown as typeof fetch,
      maxBytes: 4,
    });
    expect(result).toMatchObject({ ok: false, reason: "too-large" });
    await expect(stat(join(oversizeDir, FINAL_NAME))).rejects.toThrow();
    await expect(stat(join(oversizeDir, `.${FINAL_NAME}.tmp`))).rejects.toThrow();
    await rm(oversizeDir, { recursive: true, force: true });
  });

  it("reports an HTTP failure without writing", async () => {
    const failDir = await mkdtemp(join(tmpdir(), "demli-apk-404-"));
    const result = await downloadApkToFile({
      url: APK_URL,
      outputDir: failDir,
      allowedPrefix: PREFIX,
      fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, reason: "http-404" });
    await expect(stat(join(failDir, FINAL_NAME))).rejects.toThrow();
    await rm(failDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Route: POST /hooks/eas-build
// ---------------------------------------------------------------------------

describe("POST /hooks/eas-build (enabled)", () => {
  let app: FastifyInstance;
  const downloadApk = vi.fn(
    async (_opts: DownloadApkOptions): Promise<DownloadResult> => ({ ok: true, bytes: 1 }),
  );

  const post = (body: string, signature?: string) =>
    app.inject({
      method: "POST",
      url: "/hooks/eas-build",
      headers: {
        "content-type": "application/json",
        ...(signature ? { "expo-signature": signature } : {}),
      },
      payload: body,
    });

  const finishedAndroid = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      id: "build-1",
      platform: "android",
      status: "finished",
      artifacts: { buildUrl: APK_URL },
      metadata: { channel: "preview" },
      ...over,
    });

  beforeAll(async () => {
    app = await buildApp({
      repos: {} as unknown as Repositories,
      env: loadEnv({ DATABASE_URL: DB_URL, EAS_WEBHOOK_SECRET: SECRET, APK_OUTPUT_DIR: tmpdir() }),
      hooks: { downloadApk },
      logger: false,
    });
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    downloadApk.mockClear();
  });

  it("rejects a request with no signature", async () => {
    const body = finishedAndroid();
    const res = await post(body);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
    expect(downloadApk).not.toHaveBeenCalled();
  });

  it("rejects a request with a forged signature", async () => {
    const body = finishedAndroid();
    const res = await post(body, "sha1=deadbeef");
    expect(res.statusCode).toBe(401);
    expect(downloadApk).not.toHaveBeenCalled();
  });

  it("accepts a valid android/finished build and schedules the refresh", async () => {
    const body = finishedAndroid();
    const res = await post(body, sign(body));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, accepted: "build-1" });
    expect(downloadApk).toHaveBeenCalledTimes(1);
    expect(downloadApk.mock.calls[0]?.[0]).toMatchObject({ url: APK_URL, allowedPrefix: PREFIX });
  });

  it("skips an iOS build (no refresh scheduled)", async () => {
    const body = finishedAndroid({ platform: "ios" });
    const res = await post(body, sign(body));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, skipped: "platform:ios" });
    expect(downloadApk).not.toHaveBeenCalled();
  });

  it("skips a non-finished build", async () => {
    const body = finishedAndroid({ status: "errored" });
    const res = await post(body, sign(body));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, skipped: "status:errored" });
    expect(downloadApk).not.toHaveBeenCalled();
  });

  it("rejects an artifact URL outside the expo prefix", async () => {
    const body = finishedAndroid({ artifacts: { buildUrl: "https://evil.example.com/x.apk" } });
    const res = await post(body, sign(body));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, skipped: "forbidden-artifact-url" });
    expect(downloadApk).not.toHaveBeenCalled();
  });
});

describe("POST /hooks/eas-build (disabled)", () => {
  it("returns 404 when EAS_WEBHOOK_SECRET is unset (route not registered)", async () => {
    const app = await buildApp({
      repos: {} as unknown as Repositories,
      env: loadEnv({ DATABASE_URL: DB_URL }),
      logger: false,
    });
    const res = await app.inject({
      method: "POST",
      url: "/hooks/eas-build",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
