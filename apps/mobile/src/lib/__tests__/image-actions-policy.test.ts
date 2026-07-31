/**
 * The rules behind "save / copy a chat image" on mobile.
 *
 * These are the parts that must not be discovered on a device: which URLs the
 * app will download from, what a file name can turn into before it reaches a
 * user-chosen folder, whether the bytes are really an image, and which formats
 * the clipboard can actually take. The native plumbing around them
 * (`SAF`, `Share`, `expo-clipboard`) is covered by the emulator smoke path, per
 * this package's testing policy.
 */

import { describe, expect, it } from "vitest";
import { ATTACHMENT_LIMITS } from "@demli/config";
import {
  IMAGE_ACTION_MAX_BYTES,
  IMAGE_ACTION_MAX_URL_LENGTH,
  decodeBase64Prefix,
  extensionForMime,
  imageActionNotice,
  imageSaveFileName,
  imageSourceKind,
  isAllowedImageUrl,
  isBlockedImageHost,
  isClipboardCopyableMime,
  isOwnAppFileUri,
  isSavableImageMime,
  parseAllowedOrigins,
  sanitizeSaveFileName,
  sniffImageMime,
  sniffImageMimeFromBase64,
} from "../image-actions/policy";

const STORAGE = "https://xyzref.supabase.co";

describe("download allow-list", () => {
  it("accepts a signed URL from a pinned origin", () => {
    expect(isAllowedImageUrl(`${STORAGE}/object/sign/a.png?token=x`, [STORAGE])).toBe(true);
  });

  it("refuses an origin that is not on the list", () => {
    expect(isAllowedImageUrl("https://evil.example.com/a.png", [STORAGE])).toBe(false);
  });

  it("refuses a sibling subdomain of a pinned origin", () => {
    expect(isAllowedImageUrl("https://evil.supabase.co/a.png", [STORAGE])).toBe(false);
  });

  it("refuses a different port on the same host", () => {
    expect(isAllowedImageUrl("https://xyzref.supabase.co:8443/a.png", [STORAGE])).toBe(false);
  });

  it("refuses anything that is not https", () => {
    for (const url of [
      "http://xyzref.supabase.co/a.png",
      "file:///sdcard/a.png",
      "content://media/external/images/1",
      "data:image/png;base64,iVBORw0KGgo=",
      "javascript:alert(1)",
    ]) {
      expect(isAllowedImageUrl(url, [])).toBe(false);
    }
  });

  it("refuses embedded credentials, which disguise where a request really goes", () => {
    expect(isAllowedImageUrl("https://user:pass@xyzref.supabase.co/a.png", [])).toBe(false);
  });

  it("refuses a URL longer than the cap, and garbage", () => {
    expect(isAllowedImageUrl(`https://a.example.com/${"x".repeat(IMAGE_ACTION_MAX_URL_LENGTH)}`, [])).toBe(false);
    expect(isAllowedImageUrl("not a url", [])).toBe(false);
    expect(isAllowedImageUrl("", [])).toBe(false);
  });

  it("refuses the phone's own network even with no allow-list pinned", () => {
    // The unpinned fallback is "any PUBLIC https host" — on a phone the private
    // ranges are the user's router and whatever else is on their Wi-Fi.
    for (const host of [
      "localhost",
      "printer.local",
      "127.0.0.1",
      "10.0.0.5",
      "192.168.1.1",
      "172.16.4.4",
      "169.254.1.1",
      "100.64.0.1",
      "intranet",
      "[::1]",
      "[fe80::1]",
      "[fd00::1]",
    ]) {
      expect(isAllowedImageUrl(`https://${host}/a.png`, [])).toBe(false);
    }
  });

  it("still allows a public host when nothing is pinned (feature over dead button)", () => {
    expect(isAllowedImageUrl("https://cdn.example.com/a.png", [])).toBe(true);
  });

  it("classifies hosts directly too", () => {
    expect(isBlockedImageHost("192.168.0.1")).toBe(true);
    expect(isBlockedImageHost("cdn.example.com")).toBe(false);
    expect(isBlockedImageHost("")).toBe(true);
  });
});

/**
 * The sender's OWN just-posted image renders from a local cache file, not from
 * a signed URL: `attachmentUrlResolver.setLocalUrl` registers it permanently so
 * the echo never waits on a round-trip. Without this branch, save/copy failed on
 * the photo you just sent and worked on the same photo after a relaunch — found
 * on the emulator, not in review.
 */
describe("our own local files", () => {
  const CACHE = "file:///data/user/0/app.demli.mobile/cache/";
  const DOCS = "file:///data/user/0/app.demli.mobile/files/";
  const ROOTS = [CACHE, DOCS];

  it("accepts a file we wrote inside our own cache", () => {
    expect(isOwnAppFileUri(`${CACHE}ImageManipulator/a5822e0f.png`, ROOTS)).toBe(true);
    expect(isOwnAppFileUri(`${DOCS}pic.jpg`, ROOTS)).toBe(true);
  });

  it("refuses anything outside those roots", () => {
    for (const uri of [
      "file:///sdcard/DCIM/other.png",
      "file:///data/user/0/com.other.app/cache/x.png",
      "file:///etc/hosts",
      "file:///data/user/0/app.demli.mobile/databases/auth.db",
    ]) {
      expect(isOwnAppFileUri(uri, ROOTS)).toBe(false);
    }
  });

  it("refuses the root itself — a directory is not an image", () => {
    expect(isOwnAppFileUri(CACHE, ROOTS)).toBe(false);
  });

  it("refuses traversal, literal or percent-encoded", () => {
    for (const uri of [
      `${CACHE}../databases/auth.db`,
      `${CACHE}a/../../databases/auth.db`,
      `${CACHE}%2e%2e/databases/auth.db`,
      `${CACHE}%2E%2E%2Fdatabases`,
      `${CACHE}pic%00.png`,
    ]) {
      expect(isOwnAppFileUri(uri, ROOTS)).toBe(false);
    }
  });

  it("refuses non-file schemes and content:// URIs", () => {
    expect(isOwnAppFileUri("content://media/external/images/1", ROOTS)).toBe(false);
    expect(isOwnAppFileUri("https://cdn.example.com/a.png", ROOTS)).toBe(false);
    expect(isOwnAppFileUri("", ROOTS)).toBe(false);
  });

  it("refuses everything when no roots are known", () => {
    expect(isOwnAppFileUri(`${CACHE}pic.png`, [])).toBe(false);
  });
});

describe("the one gate both actions run", () => {
  const CACHE = "file:///data/user/0/app.demli.mobile/cache/";
  const scope = { allowedOrigins: [STORAGE], localRoots: [CACHE] };

  it("classifies a signed URL as remote and our cache file as local", () => {
    expect(imageSourceKind(`${STORAGE}/object/sign/a.png?token=x`, scope)).toBe("remote");
    expect(imageSourceKind(`${CACHE}ImageManipulator/a.png`, scope)).toBe("local");
  });

  it("refuses everything else — that is the `not_allowed` path", () => {
    expect(imageSourceKind("https://evil.example.com/a.png", scope)).toBeNull();
    expect(imageSourceKind("file:///sdcard/DCIM/x.png", scope)).toBeNull();
    expect(imageSourceKind("http://xyzref.supabase.co/a.png", scope)).toBeNull();
  });
});

describe("origin spec parsing", () => {
  it("splits on spaces and commas, keeps only https origins", () => {
    expect(parseAllowedOrigins(`${STORAGE}, http://nope.example.com  https://b.example.com/x`)).toEqual([
      STORAGE,
      "https://b.example.com",
    ]);
  });

  it("degrades to an empty list rather than throwing on junk", () => {
    expect(parseAllowedOrigins("::::")).toEqual([]);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });
});

describe("save file names", () => {
  it("forces the extension to match the real MIME", () => {
    expect(sanitizeSaveFileName("photo", "image/jpeg")).toBe("photo.jpg");
    expect(sanitizeSaveFileName("photo.png", "image/webp")).toBe("photo.webp");
  });

  it("collapses directory traversal to a plain name", () => {
    expect(sanitizeSaveFileName("../../etc/passwd", "image/png")).toBe("passwd.png");
    expect(sanitizeSaveFileName("..\\..\\Startup\\x", "image/png")).toBe("x.png");
    expect(sanitizeSaveFileName("C:evil", "image/png")).toBe("evil.png");
  });

  it("drops characters a file name may not carry", () => {
    expect(sanitizeSaveFileName('a<b>c:d"e|f?g*h', "image/png")).toBe("abcdefgh.png");
  });

  it("neutralizes an executable-looking extension instead of honouring it", () => {
    expect(sanitizeSaveFileName("payload.apk", "image/png")).toBe("payload.apk.png");
  });

  it("falls back rather than producing an empty or reserved name", () => {
    expect(sanitizeSaveFileName("   ", "image/png")).toBe("image.png");
    expect(sanitizeSaveFileName("...", "image/png")).toBe("image.png");
    expect(sanitizeSaveFileName("nul", "image/png")).toBe("_nul.png");
  });

  it("generates a sortable, collision-resistant name from the attachment", () => {
    const name = imageSaveFileName({
      id: "att_9f3b21",
      mime: "image/jpeg",
      createdAt: "2026-07-27T10:20:30.000Z",
    });
    // Suffix = the id with punctuation stripped, first four chars — enough to
    // separate two images posted in the same SECOND (a multi-select upload).
    expect(name).toMatch(/^demli-image-\d{8}-\d{6}-att9\.jpg$/);
  });

  it("survives an unparsable createdAt instead of writing 'NaN' into the name", () => {
    const name = imageSaveFileName({ id: "att_1", mime: "image/png", createdAt: "not-a-date" });
    expect(name).not.toContain("NaN");
    expect(name.endsWith(".png")).toBe(true);
  });
});

describe("format gates", () => {
  it("only the API's own upload whitelist is savable — SVG stays out", () => {
    for (const mime of ATTACHMENT_LIMITS.image.mimes) expect(isSavableImageMime(mime)).toBe(true);
    expect(isSavableImageMime("image/svg+xml")).toBe(false);
    expect(isSavableImageMime("text/html")).toBe(false);
  });

  it("the clipboard takes PNG/JPEG only — WebP and GIF are refused up front", () => {
    expect(isClipboardCopyableMime("image/png")).toBe(true);
    expect(isClipboardCopyableMime("image/jpeg")).toBe(true);
    // These decode to nothing natively; offering them would put an EMPTY
    // clipboard behind a button that looked like it worked.
    expect(isClipboardCopyableMime("image/webp")).toBe(false);
    expect(isClipboardCopyableMime("image/gif")).toBe(false);
  });

  it("maps each MIME to the extension it is saved under", () => {
    expect(extensionForMime("image/jpeg")).toBe("jpg");
    expect(extensionForMime("image/gif")).toBe("gif");
    expect(extensionForMime("application/zip")).toBe("png");
  });

  it("uses the same byte cap the API enforced on upload", () => {
    expect(IMAGE_ACTION_MAX_BYTES).toBe(ATTACHMENT_LIMITS.image.maxBytes);
  });
});

describe("magic numbers, not declared types", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
  const webp = Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
  ]);

  it("identifies each whitelisted format", () => {
    expect(sniffImageMime(png)).toBe("image/png");
    expect(sniffImageMime(jpeg)).toBe("image/jpeg");
    expect(sniffImageMime(gif)).toBe("image/gif");
    expect(sniffImageMime(webp)).toBe("image/webp");
  });

  it("refuses anything else, including an SVG that declares image/png", () => {
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
    expect(sniffImageMime(svg)).toBeNull();
    expect(sniffImageMime(new Uint8Array([]))).toBeNull();
    expect(sniffImageMime(Uint8Array.from([0x89, 0x50]))).toBeNull(); // truncated PNG header
  });

  it("reads the magic number straight off base64, without decoding the whole file", () => {
    const toBase64 = (bytes: Uint8Array): string =>
      Buffer.from(bytes).toString("base64");
    // A megabyte of payload behind an 8-byte header — the prefix decoder must
    // not walk it.
    const big = new Uint8Array(1024 * 1024);
    big.set(png.slice(0, 8), 0);
    expect(sniffImageMimeFromBase64(toBase64(big))).toBe("image/png");
    expect(sniffImageMimeFromBase64(toBase64(jpeg))).toBe("image/jpeg");
    expect(sniffImageMimeFromBase64(toBase64(new TextEncoder().encode("hello world")))).toBeNull();
  });

  it("decodes a base64 prefix exactly, tolerating wrapped input", () => {
    const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const wrapped = Buffer.from(bytes).toString("base64").replace(/(.{4})/g, "$1\n");
    expect([...decodeBase64Prefix(wrapped, 9)]).toEqual([...bytes]);
    expect([...decodeBase64Prefix(wrapped, 3)]).toEqual([1, 2, 3]);
  });
});

describe("what the user is told", () => {
  it("says nothing at all when the picker was dismissed", () => {
    expect(imageActionNotice("save", { status: "canceled" })).toBeNull();
    expect(imageActionNotice("copy", { status: "canceled" })).toBeNull();
  });

  it("confirms a save and a copy", () => {
    expect(imageActionNotice("save", { status: "saved" })).toEqual({
      tone: "ok",
      key: "mobile:attachments.saved",
    });
    expect(imageActionNotice("copy", { status: "copied" })).toEqual({
      tone: "ok",
      key: "mobile:attachments.copied",
    });
  });

  it("gives an HONEST line for a format the clipboard cannot take", () => {
    // The founder-visible failure this exists to prevent: a copy that appears to
    // work and leaves an empty clipboard.
    expect(imageActionNotice("copy", { status: "error", reason: "unsupported_format" })).toEqual({
      tone: "error",
      key: "mobile:attachments.copyUnsupported",
    });
  });

  it("does not leak WHICH rule refused — one generic line per action", () => {
    for (const reason of ["not_allowed", "download_failed", "write_failed"] as const) {
      expect(imageActionNotice("save", { status: "error", reason })).toEqual({
        tone: "error",
        key: "mobile:attachments.saveFailed",
      });
    }
    for (const reason of ["not_allowed", "download_failed", "clipboard_failed"] as const) {
      expect(imageActionNotice("copy", { status: "error", reason })).toEqual({
        tone: "error",
        key: "mobile:attachments.copyFailed",
      });
    }
  });
});
