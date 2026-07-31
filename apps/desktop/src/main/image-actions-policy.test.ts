import { describe, expect, it } from "vitest";
import {
  extensionForMime,
  hasImageActionOrigins,
  IMAGE_ACTION_MAX_BYTES,
  IMAGE_ACTION_MAX_PIXELS,
  isAllowedImageUrl,
  isBlockedImageHost,
  isClipboardDecodableMime,
  isSavableImageMime,
  isWithinPixelBudget,
  parseAllowedOrigins,
  readImageDimensions,
  resolveImageActionOrigins,
  sanitizeSaveFileName,
  sniffImageMime,
} from "./image-actions-policy";

const STORAGE = "https://abcdef.supabase.co";
const API = "https://api.getdemli.com";
const PINNED = [STORAGE, API];

describe("parseAllowedOrigins", () => {
  it("normalizes a space- or comma-separated spec to https origins", () => {
    expect(parseAllowedOrigins(`${STORAGE}/storage/v1, ${API}`)).toEqual([STORAGE, API]);
  });

  it("drops non-https and unparsable tokens instead of throwing", () => {
    expect(parseAllowedOrigins("http://insecure.example.com not-a-url  ")).toEqual([]);
  });

  it("de-duplicates repeated origins", () => {
    expect(parseAllowedOrigins(`${STORAGE} ${STORAGE}/a/b`)).toEqual([STORAGE]);
  });
});

describe("resolveImageActionOrigins", () => {
  const env = {
    DEMLI_STORAGE_ORIGIN: "https://from-env.example.com",
    DEMLI_DOMAIN: "envdomain.com",
  };

  it("IGNORES the environment in a packaged build", () => {
    // A packaged app's environment belongs to whoever launched it, and on
    // Windows any user can write HKCU\Environment without admin rights. Only the
    // build-time constant may widen this list.
    expect(resolveImageActionOrigins(STORAGE, env, true)).toEqual([STORAGE]);
  });

  it("leaves a packaged build with NO origins when nothing was baked in", () => {
    expect(resolveImageActionOrigins("", env, true)).toEqual([]);
    expect(hasImageActionOrigins(resolveImageActionOrigins("", env, true))).toBe(false);
  });

  it("still merges the environment for `pnpm dev:desktop`", () => {
    expect(resolveImageActionOrigins(STORAGE, env, false)).toEqual([
      STORAGE,
      "https://from-env.example.com",
      "https://api.envdomain.com",
    ]);
  });

  it("tolerates an empty environment", () => {
    expect(resolveImageActionOrigins(`${STORAGE} ${API}`, {}, false)).toEqual([STORAGE, API]);
  });
});

describe("isAllowedImageUrl — the download allow-list", () => {
  it("accepts a signed URL on a pinned storage origin", () => {
    const url = `${STORAGE}/storage/v1/object/sign/attachments/abc/def.png?token=xyz`;
    expect(isAllowedImageUrl(url, PINNED)).toBe(true);
  });

  it("REFUSES any other https origin when origins are pinned", () => {
    expect(isAllowedImageUrl("https://evil.example.com/x.png", PINNED)).toBe(false);
  });

  it("refuses a sibling subdomain of a pinned origin", () => {
    expect(isAllowedImageUrl("https://evil.supabase.co/x.png", PINNED)).toBe(false);
  });

  it("refuses a different port on a pinned host", () => {
    expect(isAllowedImageUrl("https://abcdef.supabase.co:8443/x.png", PINNED)).toBe(false);
  });

  it("refuses a host that merely starts with a pinned origin", () => {
    expect(isAllowedImageUrl("https://api.getdemli.com.evil.test/x.png", PINNED)).toBe(false);
  });

  it("refuses non-https schemes even on a pinned host", () => {
    expect(isAllowedImageUrl("http://abcdef.supabase.co/x.png", PINNED)).toBe(false);
    expect(isAllowedImageUrl("file:///C:/Windows/win.ini", PINNED)).toBe(false);
    expect(isAllowedImageUrl("data:image/png;base64,AAAA", PINNED)).toBe(false);
    expect(isAllowedImageUrl("blob:https://abcdef.supabase.co/1234", PINNED)).toBe(false);
  });

  it("refuses credentials embedded in the URL", () => {
    expect(isAllowedImageUrl("https://user:pw@abcdef.supabase.co/x.png", PINNED)).toBe(false);
  });

  it("refuses garbage and over-long URLs", () => {
    expect(isAllowedImageUrl("", PINNED)).toBe(false);
    expect(isAllowedImageUrl("not a url", PINNED)).toBe(false);
    expect(isAllowedImageUrl(`${STORAGE}/${"a".repeat(4000)}.png`, PINNED)).toBe(false);
  });

  it("refuses loopback, private and intranet targets", () => {
    for (const url of [
      "https://localhost/x.png",
      "https://127.0.0.1/x.png",
      "https://10.0.0.5/x.png",
      "https://192.168.1.10/x.png",
      "https://172.20.0.4/x.png",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/x.png",
      "https://intranet/x.png",
      "https://printer.local/x.png",
    ]) {
      expect(isAllowedImageUrl(url, [...PINNED, new URL(url).origin])).toBe(false);
    }
  });

  describe("unpinned build (empty allow-list) — FAIL-CLOSED", () => {
    it("refuses EVERY url, including an ordinary public https host", () => {
      // Security review 2026-07-27: an empty list used to mean "any public https
      // host", which made main a general GET proxy for the renderer — more power
      // than the renderer's own CSP grants it. A build that pinned nothing has
      // no image actions at all, and the UI hides the entries.
      expect(isAllowedImageUrl("https://cdn.example.com/x.png", [])).toBe(false);
      expect(isAllowedImageUrl(`${STORAGE}/a.png`, [])).toBe(false);
      expect(isAllowedImageUrl("http://cdn.example.com/x.png", [])).toBe(false);
    });

    it("is reported to the UI as 'feature unavailable'", () => {
      expect(hasImageActionOrigins([])).toBe(false);
      expect(hasImageActionOrigins(PINNED)).toBe(true);
    });
  });
});

describe("isBlockedImageHost", () => {
  it("allows ordinary public hosts", () => {
    expect(isBlockedImageHost("abcdef.supabase.co")).toBe(false);
    expect(isBlockedImageHost("8.8.8.8")).toBe(false);
    expect(isBlockedImageHost("2606:4700::1111")).toBe(false);
  });

  it("blocks unique-local, link-local and site-local IPv6", () => {
    expect(isBlockedImageHost("fd00::1")).toBe(true);
    expect(isBlockedImageHost("fe80::1")).toBe(true);
    expect(isBlockedImageHost("fec0::1")).toBe(true);
  });

  /**
   * The five escapes found by the 2026-07-27 security review. Each one reached a
   * private target through a host shape the old checks did not normalize.
   */
  describe("SSRF escapes (security review 2026-07-27)", () => {
    it("blocks IPv4-mapped IPv6, in the hex form the URL parser produces", () => {
      // new URL("https://[::ffff:127.0.0.1]/").hostname === "[::ffff:7f00:1]"
      expect(isBlockedImageHost("[::ffff:7f00:1]")).toBe(true);
      expect(isBlockedImageHost("[::ffff:127.0.0.1]")).toBe(true);
      // Cloud metadata — the single highest-value SSRF target.
      expect(isBlockedImageHost("[::ffff:a9fe:a9fe]")).toBe(true);
      expect(isBlockedImageHost("[::ffff:169.254.169.254]")).toBe(true);
      expect(isBlockedImageHost("[::ffff:10.0.0.5]")).toBe(true);
      expect(isBlockedImageHost("[::ffff:a00:5]")).toBe(true);
      expect(isBlockedImageHost("[::ffff:192.168.1.1]")).toBe(true);
      expect(isBlockedImageHost("[::ffff:c0a8:101]")).toBe(true);
    });

    it("blocks a trailing-dot spelling of a private name", () => {
      expect(isBlockedImageHost("localhost.")).toBe(true);
      expect(isBlockedImageHost("printer.local.")).toBe(true);
    });

    it("blocks multi-label internal names", () => {
      expect(isBlockedImageHost("metadata.google.internal")).toBe(true);
      expect(isBlockedImageHost("nas.lan")).toBe(true);
      expect(isBlockedImageHost("db.corp")).toBe(true);
      expect(isBlockedImageHost("router.home.arpa")).toBe(true);
    });

    it("blocks the same escapes end-to-end through isAllowedImageUrl", () => {
      for (const host of [
        "[::ffff:127.0.0.1]",
        "[::ffff:169.254.169.254]",
        "[::ffff:10.0.0.5]",
        "[::ffff:192.168.1.1]",
        "localhost.",
        "metadata.google.internal",
      ]) {
        const url = `https://${host}/x.png`;
        // Pinned to its OWN origin, so only the host rule can refuse it.
        expect(isAllowedImageUrl(url, [new URL(url).origin])).toBe(false);
      }
    });
  });

  it("blocks other IPv4-carrying IPv6 forms", () => {
    expect(isBlockedImageHost("::127.0.0.1")).toBe(true); // IPv4-compatible
    expect(isBlockedImageHost("::")).toBe(true);
    expect(isBlockedImageHost("64:ff9b::169.254.169.254")).toBe(true); // NAT64
    expect(isBlockedImageHost("2002:a9fe:a9fe::1")).toBe(true); // 6to4
  });

  it("still allows a PUBLIC address wearing those clothes", () => {
    expect(isBlockedImageHost("[::ffff:8.8.8.8]")).toBe(false);
    expect(isBlockedImageHost("2002:0808:0808::1")).toBe(false);
  });

  it("refuses an IPv6-shaped host it cannot parse rather than guessing", () => {
    expect(isBlockedImageHost("::gggg:1")).toBe(true);
    expect(isBlockedImageHost("1::2::3")).toBe(true);
  });

  it("does not block a public host that merely CONTAINS an internal suffix", () => {
    expect(isBlockedImageHost("internal.example.com")).toBe(false);
    expect(isBlockedImageHost("mylan.example.com")).toBe(false);
    expect(isBlockedImageHost("localhost.example.com")).toBe(false);
  });
});

describe("sanitizeSaveFileName", () => {
  it("keeps a normal name and forces the MIME's extension", () => {
    expect(sanitizeSaveFileName("holiday.png", "image/png")).toBe("holiday.png");
    expect(sanitizeSaveFileName("holiday", "image/jpeg")).toBe("holiday.jpg");
    expect(sanitizeSaveFileName("holiday.png", "image/webp")).toBe("holiday.webp");
  });

  it("strips traversal segments down to the last one", () => {
    expect(sanitizeSaveFileName("../../etc/passwd", "image/png")).toBe("passwd.png");
    expect(sanitizeSaveFileName("..\\..\\Startup\\evil", "image/png")).toBe("evil.png");
    expect(sanitizeSaveFileName("..", "image/png")).toBe("image.png");
    expect(sanitizeSaveFileName("/", "image/png")).toBe("image.png");
  });

  it("strips a drive letter", () => {
    expect(sanitizeSaveFileName("C:\\Windows\\System32\\evil.png", "image/png")).toBe("evil.png");
    expect(sanitizeSaveFileName("C:evil.png", "image/png")).toBe("evil.png");
  });

  it("strips control characters and Windows-illegal punctuation", () => {
    const withControls = `a${String.fromCharCode(0)}b${String.fromCharCode(10)}c${String.fromCharCode(127)}`;
    expect(sanitizeSaveFileName(withControls, "image/png")).toBe("abc.png");
    expect(sanitizeSaveFileName('a<b>c:"d|e?f*g', "image/png")).toBe("abcdefg.png");
  });

  it("strips trailing dots and spaces that Windows would drop", () => {
    expect(sanitizeSaveFileName("evil.png.  ", "image/png")).toBe("evil.png");
    expect(sanitizeSaveFileName("....", "image/png")).toBe("image.png");
  });

  it("neutralizes a double extension instead of trusting it", () => {
    expect(sanitizeSaveFileName("payload.exe", "image/png")).toBe("payload.exe.png");
  });

  it("escapes Windows reserved device names", () => {
    expect(sanitizeSaveFileName("CON.png", "image/png")).toBe("_CON.png");
    expect(sanitizeSaveFileName("lpt1", "image/png")).toBe("_lpt1.png");
  });

  it("escapes a device name that hides behind a second extension", () => {
    // Win32 resolves the device from the label before the FIRST dot, so
    // `con.txt` is still CON — checking the whole base missed this.
    expect(sanitizeSaveFileName("con.txt", "image/png")).toBe("_con.txt.png");
    expect(sanitizeSaveFileName("NUL.tar.gz", "image/png")).toBe("_NUL.tar.gz.png");
    expect(sanitizeSaveFileName("con .txt", "image/png")).toBe("_con .txt.png");
  });

  it("strips bidi controls that make the shown name differ from the real one", () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE: "holiday<RLO>gnp.png" is RENDERED as
    // "holidaypng.gnp" while the bytes on disk say something else.
    const rlo = String.fromCharCode(0x202e);
    expect(sanitizeSaveFileName(`holiday${rlo}gnp.png`, "image/png")).toBe("holidaygnp.png");

    const controls = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x200e, 0x200f, 0x2066, 0x2069];
    for (const code of controls) {
      expect(sanitizeSaveFileName(`a${String.fromCharCode(code)}b`, "image/png")).toBe("ab.png");
    }
  });

  it("falls back and truncates instead of producing an unusable name", () => {
    expect(sanitizeSaveFileName("", "image/gif")).toBe("image.gif");
    expect(sanitizeSaveFileName("   ", "image/png")).toBe("image.png");
    const long = sanitizeSaveFileName("x".repeat(400), "image/png");
    expect(long.length).toBeLessThanOrEqual(104);
    expect(long.endsWith(".png")).toBe(true);
  });
});

describe("sniffImageMime", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
  const webp = Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
  ]);

  it("identifies the four whitelisted formats", () => {
    expect(sniffImageMime(png)).toBe("image/png");
    expect(sniffImageMime(jpeg)).toBe("image/jpeg");
    expect(sniffImageMime(gif)).toBe("image/gif");
    expect(sniffImageMime(webp)).toBe("image/webp");
  });

  it("rejects an executable, an SVG and an empty body", () => {
    expect(sniffImageMime(Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]))).toBeNull();
    expect(sniffImageMime(new TextEncoder().encode("<svg xmlns="))).toBeNull();
    expect(sniffImageMime(new Uint8Array(0))).toBeNull();
  });
});

describe("mime helpers", () => {
  it("mirrors the API's image whitelist and excludes SVG", () => {
    expect(isSavableImageMime("image/png")).toBe(true);
    expect(isSavableImageMime("image/jpeg")).toBe(true);
    expect(isSavableImageMime("image/webp")).toBe(true);
    expect(isSavableImageMime("image/gif")).toBe(true);
    expect(isSavableImageMime("image/svg+xml")).toBe(false);
    expect(isSavableImageMime("application/octet-stream")).toBe(false);
  });

  it("maps each MIME to its save extension", () => {
    expect(extensionForMime("image/jpeg")).toBe("jpg");
    expect(extensionForMime("image/gif")).toBe("gif");
  });

  it("only claims clipboard support for what nativeImage can decode", () => {
    expect(isClipboardDecodableMime("image/png")).toBe(true);
    expect(isClipboardDecodableMime("image/jpeg")).toBe(true);
    expect(isClipboardDecodableMime("image/webp")).toBe(false);
    expect(isClipboardDecodableMime("image/gif")).toBe(false);
  });

  it("caps a download at the same 10 MB the API allows on upload", () => {
    expect(IMAGE_ACTION_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// Decompression bomb (security review 2026-07-27)
// ---------------------------------------------------------------------------

/** A PNG header declaring `width × height`; the rest of the file is irrelevant. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR chunk length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** A GIF87a/89a logical screen descriptor. */
function gifHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

/** A minimal JPEG: SOI, an APP0 segment to skip, then an SOF0 frame header. */
function jpegHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8], 0); // SOI
  bytes.set([0xff, 0xe0], 2); // APP0
  view.setUint16(4, 8); // length (incl. the 2 length bytes)
  bytes.set([0xff, 0xc0], 12); // SOF0
  view.setUint16(14, 17); // length
  bytes[16] = 8; // sample precision
  view.setUint16(17, height);
  view.setUint16(19, width);
  return bytes;
}

/** A VP8X (extended) WebP container, whose canvas size is stored minus one. */
function webpHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
  bytes.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
  return bytes;
}

describe("readImageDimensions", () => {
  it("reads the size out of each format's header", () => {
    expect(readImageDimensions(pngHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(readImageDimensions(gifHeader(640, 480))).toEqual({ width: 640, height: 480 });
    expect(readImageDimensions(jpegHeader(4032, 3024))).toEqual({ width: 4032, height: 3024 });
    expect(readImageDimensions(webpHeader(800, 600))).toEqual({ width: 800, height: 600 });
  });

  it("returns null for bytes that are not a whitelisted image", () => {
    expect(readImageDimensions(new TextEncoder().encode("<svg xmlns="))).toBeNull();
    expect(readImageDimensions(new Uint8Array(0))).toBeNull();
  });
});

describe("isWithinPixelBudget — the decompression-bomb guard", () => {
  it("passes ordinary photos and screenshots", () => {
    expect(isWithinPixelBudget(pngHeader(1920, 1080))).toBe(true);
    expect(isWithinPixelBudget(jpegHeader(4032, 3024))).toBe(true);
    expect(isWithinPixelBudget(gifHeader(500, 500))).toBe(true);
    expect(isWithinPixelBudget(webpHeader(2560, 1440))).toBe(true);
  });

  it("REFUSES a bomb whose bytes are far under the 10 MB cap", () => {
    // 40000 x 40000 single-colour PNG: a few hundred KB on the wire, ~6.4 GB of
    // RGBA once decoded in the main process.
    const bomb = pngHeader(40_000, 40_000);
    expect(bomb.byteLength).toBeLessThan(IMAGE_ACTION_MAX_BYTES);
    expect(isWithinPixelBudget(bomb)).toBe(false);
    expect(isWithinPixelBudget(jpegHeader(30_000, 30_000))).toBe(false);
    expect(isWithinPixelBudget(gifHeader(60_000, 60_000))).toBe(false);
    expect(isWithinPixelBudget(webpHeader(20_000, 20_000))).toBe(false);
  });

  it("refuses an image whose header will not state a size (fail-closed)", () => {
    expect(isWithinPixelBudget(pngHeader(0, 0))).toBe(false);
    // Sniffs as PNG, but the IHDR chunk is missing.
    const truncated = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(isWithinPixelBudget(truncated)).toBe(false);
    expect(isWithinPixelBudget(new Uint8Array(0))).toBe(false);
  });

  it("sits exactly on the documented budget", () => {
    expect(IMAGE_ACTION_MAX_PIXELS).toBe(64_000_000);
    expect(isWithinPixelBudget(pngHeader(8000, 8000))).toBe(true); // 64.0 MP
    expect(isWithinPixelBudget(pngHeader(8000, 8001))).toBe(false);
  });
});
