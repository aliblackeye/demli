/**
 * Subframe navigation policy (Watch Party, M20 / ADR 0016).
 *
 * The interesting cases are the refusals. A `frame-src` CSP stops a page being
 * FRAMED; this predicate stops a frame that is already there from navigating
 * itself somewhere else, and it is the only thing standing between "we embed a
 * video player" and "an embed can point a frame of our app at anything".
 */

import { describe, expect, it } from "vitest";
import { isAllowedFrameUrl } from "./frame-navigation-policy";

describe("isAllowedFrameUrl", () => {
  it("allows the embed origin and the hosts the player navigates between", () => {
    expect(isAllowedFrameUrl("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ")).toBe(true);
    expect(isAllowedFrameUrl("https://youtube-nocookie.com/embed/dQw4w9WgXcQ")).toBe(true);
    expect(isAllowedFrameUrl("https://www.youtube.com/embed/dQw4w9WgXcQ?enablejsapi=1")).toBe(
      true,
    );
    // A fresh iframe, and the player's own helper frames.
    expect(isAllowedFrameUrl("about:blank")).toBe(true);
  });

  it("allows about:blank EXACTLY, not the whole about: scheme", () => {
    // `about:srcdoc` is a frame whose content is chosen by whoever wrote the
    // embedding markup — unlike about:blank, which carries nobody's content.
    // Nothing creates one today; the point is that the predicate cannot be read
    // as "any about: URL is fine" by the next person to touch it.
    expect(isAllowedFrameUrl("about:srcdoc")).toBe(false);
    expect(isAllowedFrameUrl("about:config")).toBe(false);
    expect(isAllowedFrameUrl("about:blank#x")).toBe(false);
  });

  it("refuses a lookalike host that a prefix check would let through", () => {
    // The whole reason this compares hostnames instead of calling startsWith.
    expect(isAllowedFrameUrl("https://www.youtube-nocookie.com.evil.test/embed/x")).toBe(false);
    expect(isAllowedFrameUrl("https://evil.test/www.youtube-nocookie.com")).toBe(false);
    expect(isAllowedFrameUrl("https://wwwXyoutube-nocookie.com/embed/x")).toBe(false);
  });

  it("refuses userinfo smuggling of the allowed host", () => {
    // `https://www.youtube-nocookie.com@evil.test/` fetches evil.test.
    expect(isAllowedFrameUrl("https://www.youtube-nocookie.com@evil.test/")).toBe(false);
  });

  it("refuses every non-https scheme", () => {
    expect(isAllowedFrameUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedFrameUrl("data:text/html,<h1>hi</h1>")).toBe(false);
    expect(isAllowedFrameUrl("file:///C:/Windows/System32/drivers/etc/hosts")).toBe(false);
    // Plaintext to the right host is still refused — TLS is not optional.
    expect(isAllowedFrameUrl("http://www.youtube-nocookie.com/embed/x")).toBe(false);
  });

  it("refuses anything that is not a URL at all (fails closed)", () => {
    expect(isAllowedFrameUrl("")).toBe(false);
    expect(isAllowedFrameUrl("not a url")).toBe(false);
    expect(isAllowedFrameUrl("//www.youtube-nocookie.com/embed/x")).toBe(false);
  });

  it("refuses ordinary third-party sites", () => {
    expect(isAllowedFrameUrl("https://example.com/")).toBe(false);
    expect(isAllowedFrameUrl("https://api.getdemli.com/health")).toBe(false);
  });
});
