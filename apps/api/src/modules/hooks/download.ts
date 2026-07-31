import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { isAllowedArtifactUrl } from "./payload.js";

/** ~500MB ceiling — an APK far exceeding this is a misconfiguration or abuse. */
export const DEFAULT_MAX_APK_BYTES = 500 * 1024 * 1024;

/**
 * The ONE public APK filename. Shared with the Caddy /download/android redirect,
 * the MOBILE_APK_URL default in ../../env.ts and REMOTE_NAME in
 * scripts/publish-mobile-apk.sh — a rename that misses one of them silently 404s
 * the download link, so scripts/check-caddyfile.mjs ("apk-alias") ties the four
 * together.
 */
export const FINAL_NAME = "demli.apk";

/** Written to first, then atomically renamed over the live file. */
const TMP_NAME = `.${FINAL_NAME}.tmp`;

export interface DownloadApkOptions {
  /** Artifact URL from the (already signature-verified) EAS payload. */
  url: string;
  /** Directory that holds demli.apk (mounted from the host download tree). */
  outputDir: string;
  /** Only URLs under this prefix are fetched (SSRF guard). */
  allowedPrefix: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  log?: (message: string) => void;
}

export interface DownloadResult {
  ok: boolean;
  reason?: string;
  bytes?: number;
}

/**
 * Stream an EAS artifact to `<outputDir>/demli.apk` atomically: download into
 * a temp file, enforce a size ceiling mid-stream, then `rename` over the live
 * file (atomic on the same filesystem, so a reader never sees a half-written
 * APK). Never throws — every failure is returned as `{ ok: false, reason }` and
 * logged, so the caller can ack the webhook regardless.
 */
export async function downloadApkToFile(options: DownloadApkOptions): Promise<DownloadResult> {
  const { url, outputDir, allowedPrefix } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_APK_BYTES;
  const log = options.log ?? (() => {});

  // Defense in depth — the route also checks, but never fetch a URL we cannot
  // vouch for even if a future caller forgets.
  if (!isAllowedArtifactUrl(url, allowedPrefix)) {
    log(`[eas-webhook] refused non-allowlisted artifact url`);
    return { ok: false, reason: "forbidden-url" };
  }

  const tmpPath = join(outputDir, TMP_NAME);
  const finalPath = join(outputDir, FINAL_NAME);

  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    log(`[eas-webhook] artifact fetch failed: ${(err as Error).message}`);
    return { ok: false, reason: "fetch-failed" };
  }
  if (!res.ok || !res.body) {
    log(`[eas-webhook] artifact fetch not ok: ${res.status}`);
    return { ok: false, reason: `http-${res.status}` };
  }

  try {
    await mkdir(outputDir, { recursive: true });
  } catch (err) {
    log(`[eas-webhook] output dir not writable: ${(err as Error).message}`);
    return { ok: false, reason: "mkdir-failed" };
  }

  let received = 0;
  const sizeLimiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      if (received > maxBytes) {
        cb(new Error("apk-too-large"));
        return;
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
      sizeLimiter,
      createWriteStream(tmpPath),
    );
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    const reason = (err as Error).message === "apk-too-large" ? "too-large" : "stream-failed";
    log(`[eas-webhook] download aborted (${reason})`);
    return { ok: false, reason };
  }

  try {
    await rename(tmpPath, finalPath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    log(`[eas-webhook] rename failed: ${(err as Error).message}`);
    return { ok: false, reason: "rename-failed" };
  }

  log(`[eas-webhook] apk refreshed (${received} bytes) -> ${finalPath}`);
  return { ok: true, bytes: received };
}
