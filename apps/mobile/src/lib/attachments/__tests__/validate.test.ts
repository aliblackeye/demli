import { describe, expect, it } from "vitest";
import { ATTACHMENT_LIMITS } from "@demli/config";
import {
  fitTileBox,
  formatBytes,
  formatMediaDuration,
  isReencodableImageMime,
  maxBytesForKind,
  mimeFromFilename,
  resolveAssetMime,
  scaleToFitEdge,
  validateAttachmentFile,
} from "../validate";

const MB = 1024 * 1024;

describe("validateAttachmentFile", () => {
  it("accepts every whitelisted mime at its cap", () => {
    for (const limit of Object.values(ATTACHMENT_LIMITS)) {
      for (const mime of limit.mimes) {
        const verdict = validateAttachmentFile({ mime, sizeBytes: limit.maxBytes });
        expect(verdict.ok).toBe(true);
      }
    }
  });

  it("rejects non-whitelisted mimes (SVG stays excluded)", () => {
    for (const mime of ["image/svg+xml", "application/pdf", "text/html", ""]) {
      expect(validateAttachmentFile({ mime, sizeBytes: 10 }).ok).toBe(false);
    }
  });

  it("passes over-cap re-encodable images with needsDownscale", () => {
    const verdict = validateAttachmentFile({
      mime: "image/jpeg",
      sizeBytes: ATTACHMENT_LIMITS.image.maxBytes + 1,
    });
    expect(verdict).toEqual({ ok: true, kind: "image", needsDownscale: true });
  });

  it("rejects an over-cap GIF outright (never re-encoded)", () => {
    const verdict = validateAttachmentFile({
      mime: "image/gif",
      sizeBytes: ATTACHMENT_LIMITS.image.maxBytes + 1,
    });
    expect(verdict.ok).toBe(false);
  });

  it("rejects over-cap audio and video with a kind-specific size key", () => {
    const audio = validateAttachmentFile({
      mime: "audio/mpeg",
      sizeBytes: ATTACHMENT_LIMITS.audio.maxBytes + 1,
    });
    expect(audio.ok).toBe(false);
    if (!audio.ok) {
      expect(audio.error.key).toBe("mobile:attachments.tooLargeAudio");
      expect(audio.error.params).toMatchObject({ cap: expect.any(String), size: expect.any(String) });
    }

    const video = validateAttachmentFile({
      mime: "video/mp4",
      sizeBytes: ATTACHMENT_LIMITS.video.maxBytes + 1,
    });
    expect(video.ok).toBe(false);
    if (!video.ok) expect(video.error.key).toBe("mobile:attachments.tooLargeVideo");
  });
});

describe("mimeFromFilename / resolveAssetMime", () => {
  it("maps whitelisted extensions (case-insensitive, uri-safe)", () => {
    expect(mimeFromFilename("photo.JPG")).toBe("image/jpeg");
    expect(mimeFromFilename("clip.mp4")).toBe("video/mp4");
    expect(mimeFromFilename("song.mp3")).toBe("audio/mpeg");
    expect(mimeFromFilename("file:///cache/a.webp?x=1#frag")).toBe("image/webp");
  });

  it("returns null for unknown or missing extensions", () => {
    expect(mimeFromFilename("archive.zip")).toBeNull();
    expect(mimeFromFilename("noextension")).toBeNull();
    expect(mimeFromFilename(null)).toBeNull();
    expect(mimeFromFilename(undefined)).toBeNull();
  });

  it("prefers a whitelisted reported mime over the extension", () => {
    expect(resolveAssetMime("image/png", "whatever.jpg")).toBe("image/png");
  });

  it("falls back to the filename when the reported mime is missing or foreign", () => {
    expect(resolveAssetMime(null, "a.gif")).toBe("image/gif");
    expect(resolveAssetMime("application/octet-stream", "a.wav")).toBe("audio/wav");
    expect(resolveAssetMime("application/octet-stream", "a.exe")).toBeNull();
  });
});

describe("scaleToFitEdge", () => {
  it("never upscales and preserves aspect ratio", () => {
    expect(scaleToFitEdge(100, 50, 4096)).toEqual({ width: 100, height: 50 });
    expect(scaleToFitEdge(8192, 4096, 4096)).toEqual({ width: 4096, height: 2048 });
  });

  it("clamps to at least 1px", () => {
    expect(scaleToFitEdge(10000, 1, 100).height).toBe(1);
  });
});

describe("fitTileBox", () => {
  it("reserves the exact box from natural dimensions without upscaling", () => {
    expect(fitTileBox(600, 300, 300, 260, { width: 288, height: 162 })).toEqual({
      width: 300,
      height: 150,
    });
    expect(fitTileBox(100, 80, 300, 260, { width: 288, height: 162 })).toEqual({
      width: 100,
      height: 80,
    });
  });

  it("uses the fallback for missing dims and 16:9 for broken dims", () => {
    const fromFallback = fitTileBox(null, null, 300, 260, { width: 288, height: 162 });
    expect(fromFallback).toEqual({ width: 288, height: 162 });
    expect(fitTileBox(0, 100, 300, 260, { width: 288, height: 162 })).toEqual({
      width: 300,
      height: Math.round((300 * 9) / 16),
    });
  });
});

describe("formatters", () => {
  it("formatBytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(3.4 * MB)).toBe("3.4 MB");
    expect(formatBytes(-1)).toBe("0 B");
  });

  it("formatMediaDuration", () => {
    expect(formatMediaDuration(62_000)).toBe("1:02");
    expect(formatMediaDuration(3_601_000)).toBe("1:00:01");
  });
});

describe("kind helpers", () => {
  it("re-encodable image mimes exclude gif", () => {
    expect(isReencodableImageMime("image/png")).toBe(true);
    expect(isReencodableImageMime("image/gif")).toBe(false);
  });

  it("maxBytesForKind matches config", () => {
    expect(maxBytesForKind("video")).toBe(ATTACHMENT_LIMITS.video.maxBytes);
  });
});
