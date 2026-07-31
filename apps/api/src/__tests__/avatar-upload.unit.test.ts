/**
 * Avatar upload validation + moderation-seam unit tests (no DB, no network).
 *
 * The security-critical surface mirrors the custom-emoji sniff: a declared MIME
 * is never trusted, so an SVG/GIF smuggled under an `image/png` label must be
 * refused BEFORE anything is stored (the public avatar bucket makes this
 * non-negotiable). The moderation seam is tested for its two default postures:
 * no module ⇒ `skipped`, and a broken module specifier ⇒ `skipped` (fail-open).
 */

import { describe, expect, it } from "vitest";
import type { ApiError } from "../errors.js";
import {
  AVATAR_MAX_BYTES,
  avatarBytesMatchMime,
  buildAvatarStoragePath,
  decodeAvatarUpload,
  isAvatarMime,
} from "../lib/avatar-upload.js";
import { createMediaModerator } from "../lib/media-moderation.js";

/**
 * A real PNG: signature + an IHDR stating `width`x`height`, padded to `bytes`.
 * The dimensions are load-bearing. The pixel-budget guard reads them, and a
 * header that will not state a size at all is refused -- so a fixture of zeroed
 * bytes behind a valid signature is NOT a valid image here, which is the whole
 * point of the guard.
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
/** A real JPEG: SOI + an APP0 segment + an SOF0 frame header stating the size. */
function jpegBase64(bytes = 64, width = 8, height = 8): string {
  const buf = Buffer.alloc(bytes);
  buf.writeUInt16BE(0xffd8, 0); // SOI
  buf.writeUInt16BE(0xffe0, 2); // APP0
  buf.writeUInt16BE(4, 4); // APP0 length (covers itself + 2 padding bytes)
  buf.writeUInt16BE(0xffc0, 8); // SOF0
  buf.writeUInt16BE(11, 10); // SOF0 length
  buf.writeUInt8(8, 12); // sample precision
  buf.writeUInt16BE(height, 13);
  buf.writeUInt16BE(width, 15);
  return buf.toString("base64");
}
/** A real lossy WebP: RIFF/WEBP container with a `VP8 ` frame stating the size. */
function webpBase64(width = 8, height = 8): string {
  const buf = Buffer.alloc(64);
  buf.write("RIFF", 0, "ascii");
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8 ", 12, "ascii");
  // The VP8 keyframe start code. Without it a reader cannot tell a frame header
  // from arbitrary bytes, so it refuses to report a size at all.
  buf.writeUInt8(0x9d, 23);
  buf.writeUInt8(0x01, 24);
  buf.writeUInt8(0x2a, 25);
  buf.writeUInt16LE(width, 26);
  buf.writeUInt16LE(height, 28);
  return buf.toString("base64");
}
function svgBase64(): string {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
  ).toString("base64");
}
function gifBase64(): string {
  const buf = Buffer.alloc(32);
  Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]).copy(buf);
  return buf.toString("base64");
}

/** Run decode and return the thrown ApiError (or null on success). */
function decodeError(input: { mime: string; dataBase64: string }): ApiError | null {
  try {
    decodeAvatarUpload(input);
    return null;
  } catch (err) {
    return err as ApiError;
  }
}

describe("avatar upload validation", () => {
  it("accepts a real png / jpeg / webp and returns the decoded bytes", () => {
    const png = decodeAvatarUpload({ mime: "image/png", dataBase64: pngBase64(128) });
    expect(png.mime).toBe("image/png");
    expect(png.bytes.length).toBe(128);

    expect(decodeAvatarUpload({ mime: "image/jpeg", dataBase64: jpegBase64() }).mime).toBe(
      "image/jpeg",
    );
    expect(decodeAvatarUpload({ mime: "image/webp", dataBase64: webpBase64() }).mime).toBe(
      "image/webp",
    );
  });

  it("REJECTS an SVG declared as image/png (stored-XSS guard)", () => {
    const err = decodeError({ mime: "image/png", dataBase64: svgBase64() });
    expect(err?.statusCode).toBe(400);
    expect(err?.code).toBe("INVALID_AVATAR");
  });

  it("REJECTS a GIF declared as image/png (no-animation rule)", () => {
    expect(decodeError({ mime: "image/png", dataBase64: gifBase64() })?.code).toBe(
      "INVALID_AVATAR",
    );
  });

  it("REJECTS a png declared as jpeg (declared type must match reality)", () => {
    expect(decodeError({ mime: "image/jpeg", dataBase64: pngBase64() })?.code).toBe(
      "INVALID_AVATAR",
    );
  });

  it("rejects a MIME outside the whitelist", () => {
    expect(isAvatarMime("image/svg+xml")).toBe(false);
    expect(isAvatarMime("image/gif")).toBe(false);
    expect(decodeError({ mime: "image/svg+xml", dataBase64: svgBase64() })?.code).toBe(
      "INVALID_AVATAR",
    );
  });

  it("enforces the 2 MB byte cap", () => {
    const err = decodeError({ mime: "image/png", dataBase64: pngBase64(AVATAR_MAX_BYTES + 1) });
    expect(err?.statusCode).toBe(413);
    expect(err?.code).toBe("AVATAR_TOO_LARGE");
  });

  it("magic-byte matcher agrees with the declared type only when they match", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(avatarBytesMatchMime(png, "image/png")).toBe(true);
    expect(avatarBytesMatchMime(png, "image/jpeg")).toBe(false);
  });

  it("builds a namespaced, extension-correct storage path with no PII in the key", () => {
    const path = buildAvatarStoragePath("00000000-0000-0000-0000-000000000000", "image/webp");
    expect(path).toMatch(/^avatars\/00000000-0000-0000-0000-000000000000\/[0-9a-f-]+\.webp$/);
  });

  // A decompression bomb passes every other gate: the MIME is whitelisted, the
  // magic bytes are genuine, and it is far under the 2 MB cap. Only the declared
  // dimensions give it away, which is why the byte cap alone is not a defence.
  it("rejects a tiny PNG whose header declares a huge canvas", () => {
    const bomb = decodeError({ mime: "image/png", dataBase64: pngBase64(128, 30_000, 30_000) });
    expect(bomb?.statusCode).toBe(400);
    expect(bomb?.code).toBe("INVALID_AVATAR");
    // The payload really is small — the size cap would have waved it through.
    expect(Buffer.from(pngBase64(128, 30_000, 30_000), "base64").length).toBe(128);
  });

  it("rejects a PNG that refuses to state a size at all", () => {
    // Valid signature, zeroed IHDR: 0x0. Unreadable dimensions are refused
    // rather than assumed safe — a header we cannot parse is one we cannot judge.
    const buf = Buffer.alloc(64);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
    const err = decodeError({ mime: "image/png", dataBase64: buf.toString("base64") });
    expect(err?.statusCode).toBe(400);
  });

  it("accepts a large-but-sane avatar, so the budget is not merely blocking everything", () => {
    expect(() =>
      decodeAvatarUpload({ mime: "image/png", dataBase64: pngBase64(256, 4000, 4000) }),
    ).not.toThrow();
  });
});

describe("media moderation seam", () => {
  it("is disabled and skips (fail-open) when the mode is off (default)", async () => {
    const moderator = createMediaModerator({});
    expect(moderator.enabled).toBe(false);
    const result = await moderator.check({
      bytes: new Uint8Array([1, 2, 3]),
      mime: "image/png",
      subject: "avatar",
    });
    expect(result.verdict).toBe("skipped");
  });

  it("skips (fail-open) when the mode is on but no module is configured", async () => {
    const moderator = createMediaModerator({ mediaModerationMode: "on" });
    // Nothing to call ⇒ not enabled, so the attachment path never does extra work.
    expect(moderator.enabled).toBe(false);
    const result = await moderator.check({
      bytes: new Uint8Array([1, 2, 3]),
      mime: "image/png",
      subject: "avatar",
    });
    expect(result.verdict).toBe("skipped");
  });

  it("skips (fail-open) when the configured module cannot be loaded", async () => {
    const moderator = createMediaModerator({
      mediaModerationMode: "on",
      mediaModerationModule: "demli-nonexistent-moderation-module-xyz",
    });
    expect(moderator.enabled).toBe(true);
    const result = await moderator.check({
      bytes: new Uint8Array([1, 2, 3]),
      mime: "image/png",
      subject: "attachment",
    });
    // A broken specifier must never throw — a moderation outage cannot block edits.
    expect(result.verdict).toBe("skipped");
  });
});
