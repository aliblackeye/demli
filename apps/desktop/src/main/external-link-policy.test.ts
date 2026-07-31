import { describe, expect, it } from "vitest";
import {
  denyWindowOpen,
  EXTERNAL_LINK_MAX_URL_LENGTH,
  isOpenableExternalUrl,
  openableExternalUrl,
} from "./external-link-policy";

/**
 * The window-open handler must be an UNCONDITIONAL deny — no in-app window, and
 * no handoff to the OS either. Before this it forwarded `https://` urls to
 * `shell.openExternal`, a path the Watch Party embed's own links could reach.
 */
describe("denyWindowOpen", () => {
  it("denies, whatever it is handed", () => {
    const handler = denyWindowOpen as (details?: unknown) => { action: string };
    expect(handler()).toEqual({ action: "deny" });
    expect(handler({ url: "https://example.test/" })).toEqual({ action: "deny" });
    expect(handler({ url: "https://getdemli.com/download/windows" })).toEqual({
      action: "deny",
    });
    expect(handler({ url: "javascript:alert(1)" })).toEqual({ action: "deny" });
  });

  it("cannot branch on the url at all — it declares no parameters", () => {
    // Structural, not behavioural: a zero-arity handler is one nobody can later
    // "just add a small https exception" to without changing its signature.
    expect(denyWindowOpen.length).toBe(0);
  });
});

/**
 * The gate on `shell.openExternal`.
 *
 * `shell.openExternal` hands a string to the OPERATING SYSTEM, which picks a
 * handler by scheme — so anything that is not http(s) is a way to start some
 * other program, and this predicate is the thing standing in front of it. It
 * must fail closed for every non-web scheme and every string that does not parse
 * as an absolute address.
 */
describe("isOpenableExternalUrl", () => {
  it("accepts ordinary https and http addresses", () => {
    expect(isOpenableExternalUrl("https://getdemli.com/download/windows")).toBe(true);
    expect(isOpenableExternalUrl("https://example.test/a/b?c=d#e")).toBe(true);
    // http is accepted deliberately: chat links to plain-http pages are real,
    // and the browser (not us) is the right place to warn about them.
    expect(isOpenableExternalUrl("http://example.test/")).toBe(true);
    expect(isOpenableExternalUrl("HTTPS://EXAMPLE.TEST/")).toBe(true);
  });

  it("refuses javascript:, data:, file: and custom schemes", () => {
    // The whole point of the gate: each of these would ask the OS to do
    // something other than "open a web page".
    expect(isOpenableExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isOpenableExternalUrl("JavaScript:alert(1)")).toBe(false);
    expect(isOpenableExternalUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isOpenableExternalUrl("file:///C:/Windows/System32/calc.exe")).toBe(false);
    expect(isOpenableExternalUrl("ms-msdt:/id PCWDiagnostic")).toBe(false);
    expect(isOpenableExternalUrl("demli://join/abc")).toBe(false);
    expect(isOpenableExternalUrl("mailto:someone@example.test")).toBe(false);
    expect(isOpenableExternalUrl("vbscript:msgbox(1)")).toBe(false);
  });

  it("refuses anything that does not parse as an absolute url", () => {
    expect(isOpenableExternalUrl("")).toBe(false);
    expect(isOpenableExternalUrl("not a url")).toBe(false);
    expect(isOpenableExternalUrl("/relative/path")).toBe(false);
    expect(isOpenableExternalUrl("//example.test/protocol-relative")).toBe(false);
    expect(isOpenableExternalUrl("example.test")).toBe(false);
    expect(isOpenableExternalUrl("https://")).toBe(false);
  });

  it("refuses non-strings", () => {
    expect(isOpenableExternalUrl(undefined)).toBe(false);
    expect(isOpenableExternalUrl(null)).toBe(false);
    expect(isOpenableExternalUrl(42)).toBe(false);
    expect(isOpenableExternalUrl({ toString: () => "https://example.test" })).toBe(false);
    expect(isOpenableExternalUrl(["https://example.test"])).toBe(false);
  });

  it("refuses embedded credentials", () => {
    // `https://getdemli.com@evil.test/` reads as our domain in a hurry but is
    // served by evil.test — refuse the shape rather than rely on the browser's
    // address bar to disambiguate it.
    expect(isOpenableExternalUrl("https://user:pass@example.test/")).toBe(false);
    expect(isOpenableExternalUrl("https://getdemli.com@evil.test/")).toBe(false);
  });

  it("bounds the url length", () => {
    const host = "https://example.test/";
    const atCap = host + "a".repeat(EXTERNAL_LINK_MAX_URL_LENGTH - host.length);
    expect(atCap.length).toBe(EXTERNAL_LINK_MAX_URL_LENGTH);
    expect(isOpenableExternalUrl(atCap)).toBe(true);
    expect(isOpenableExternalUrl(`${atCap}a`)).toBe(false);
  });
  it("returns the NORMALIZED url, so the OS never sees the raw string", () => {
    // The parse-versus-use gap. `new URL()` accepts each of these; its serializer
    // rewrites them. Forwarding the raw string instead of `.href` is how a
    // quote-and-space payload survives into the default browser's registry `%1`
    // template on Windows — classic argument injection, with the whole string
    // attacker-chosen (a link pasted into chat and clicked in the renderer).
    expect(openableExternalUrl('https://good.test/a" --gpu-launcher=calc.exe')).toBe(
      "https://good.test/a%22%20--gpu-launcher=calc.exe",
    );
    // A tab inside the scheme, and leading control characters, are stripped by the
    // parser — the raw form must not be what reaches the OS.
    expect(openableExternalUrl("ht\ttps://evil.test/x")).toBe("https://evil.test/x");
    expect(openableExternalUrl("  \r\n https://evil.test/x")).toBe("https://evil.test/x");
    // Homograph folds to punycode as a side effect of normalizing.
    expect(openableExternalUrl("https://еxample.test/")).toBe("https://xn--xample-2of.test/");
  });

  it("bounds the SERIALIZED length, not just the input", () => {
    // Percent-encoding can only grow the string, so a url that fits the cap raw
    // can exceed it once normalized — and the cap exists to bound what reaches an
    // OS API, which is the normalized form.
    const host = "https://example.test/";
    const raw = host + '"'.repeat(EXTERNAL_LINK_MAX_URL_LENGTH - host.length);
    expect(raw.length).toBe(EXTERNAL_LINK_MAX_URL_LENGTH);
    expect(openableExternalUrl(raw)).toBeNull();
  });
});
