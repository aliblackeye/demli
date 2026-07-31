/**
 * The bridge is the ONE place mobile deviates from the desktop player's
 * transport, so it is the one place a security property can quietly go missing.
 * These tests pin the properties, not the markup.
 */
import { describe, expect, it } from "vitest";
import { YOUTUBE_EMBED_ORIGIN, parsePlayerMessage } from "@demli/client-core";
import {
  allowWatchNavigation,
  postToPlayerScript,
  volumeCommand,
  watchPlayerHtml,
  WATCH_DOCUMENT_BASE_URL,
} from "./watch-player-bridge";

const SRC = `${YOUTUBE_EMBED_ORIGIN}/embed/dQw4w9WgXcQ?enablejsapi=1&controls=0`;

describe("watchPlayerHtml", () => {
  const html = watchPlayerHtml(SRC);

  it("frames the embed URL it was given", () => {
    expect(html).toContain(`src="${SRC.replace(/&/g, "&amp;")}"`);
  });

  it("posts outbound frames to the embed origin, never to '*'", () => {
    expect(html).toContain(`postMessage(payload, ORIGIN)`);
    expect(html).toContain(`var ORIGIN = "${YOUTUBE_EMBED_ORIGIN}"`);
    expect(html).not.toContain(`postMessage(payload, "*")`);
    expect(html).not.toContain(`, '*')`);
  });

  it("drops inbound frames from any other origin AND any other window", () => {
    // Both gates are required. Origin alone would accept a message from a
    // different frame that happens to be on the same host; source alone would
    // accept our own frame after it navigated somewhere else.
    expect(html).toContain("if (event.origin !== ORIGIN) return;");
    expect(html).toContain("if (!frame || event.source !== frame.contentWindow) return;");
  });

  it("carries a CSP that permits nothing except framing the embed origin", () => {
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(`frame-src ${YOUTUBE_EMBED_ORIGIN}`);
    // No remote script may be loaded: the relay is inline, and ADR 0016's whole
    // containment argument is that this feature adds no script origin.
    expect(html).not.toContain("<script src");
  });

  it("escapes the src into the attribute so a crafted URL cannot break out", () => {
    const hostile = watchPlayerHtml(`${YOUTUBE_EMBED_ORIGIN}/embed/x"><script>bad()</script>`);
    expect(hostile).not.toContain("<script>bad()");
    expect(hostile).toContain("&quot;&gt;&lt;script&gt;");
  });
});

describe("postToPlayerScript", () => {
  it("passes the payload through as a JS string literal", () => {
    const payload = JSON.stringify({ event: "command", func: "playVideo" });
    const script = postToPlayerScript(payload);
    expect(script).toContain(JSON.stringify(payload));
    // `injectJavaScript` warns on a non-primitive result, and this is called
    // several times a second.
    expect(script.trimEnd().endsWith("true;")).toBe(true);
  });

  it("cannot be escaped by quotes or a line break in the payload", () => {
    const script = postToPlayerScript(`");evil();("`);
    expect(script).not.toContain(`");evil();("`);
    expect(script).toContain("\\\"");
    // The whole injected string must remain one parseable expression statement.
    expect(() => new Function(`var window={};${script}`)).not.toThrow();
  });

  it("survives a payload containing a newline", () => {
    const script = postToPlayerScript('a\nb');
    expect(script).not.toMatch(/\n\s*b/);
    expect(() => new Function(`var window={};${script}`)).not.toThrow();
  });
});

describe("volumeCommand", () => {
  it("emits a setVolume frame the embed protocol understands", () => {
    // Round-trips through the same parser the player uses for inbound frames,
    // which is the cheapest proof it is well-formed JSON of the right shape.
    const frame = JSON.parse(volumeCommand(60)) as Record<string, unknown>;
    expect(frame).toMatchObject({ event: "command", func: "setVolume", args: [60] });
  });

  it("clamps to the 0–100 the player accepts", () => {
    expect(JSON.parse(volumeCommand(-20)).args).toEqual([0]);
    expect(JSON.parse(volumeCommand(400)).args).toEqual([100]);
    expect(JSON.parse(volumeCommand(33.7)).args).toEqual([34]);
  });
});

describe("WATCH_DOCUMENT_BASE_URL", () => {
  it("is a real https origin — an opaque one is what error 153 refuses", () => {
    expect(WATCH_DOCUMENT_BASE_URL.startsWith("https://")).toBe(true);
  });

  it("is NOT a YouTube origin", () => {
    // Load-bearing. The embed navigates its own subframes to youtube.com during
    // normal playback; if our document claimed that origin, such a subframe
    // would be SAME-ORIGIN with us and could call
    // `parent.ReactNativeWebView.postMessage` directly — around the relay and
    // past both of its checks — to forge player frames.
    expect(WATCH_DOCUMENT_BASE_URL).not.toContain("youtube");
    expect(new URL(WATCH_DOCUMENT_BASE_URL).hostname).not.toMatch(/youtube/i);
    expect(new URL(YOUTUBE_EMBED_ORIGIN).hostname).not.toBe(
      new URL(WATCH_DOCUMENT_BASE_URL).hostname,
    );
  });
});

describe("allowWatchNavigation", () => {
  it("permits only the document we handed the WebView in the TOP frame", () => {
    expect(allowWatchNavigation({ url: "about:blank", isTopFrame: true })).toBe(true);
    expect(allowWatchNavigation({ url: "data:text/html;base64,abc", isTopFrame: true })).toBe(
      true,
    );
    // With a base URL set, the platform reports the initial load as that URL.
    expect(allowWatchNavigation({ url: WATCH_DOCUMENT_BASE_URL, isTopFrame: true })).toBe(true);
    expect(allowWatchNavigation({ url: `${WATCH_DOCUMENT_BASE_URL}/`, isTopFrame: true })).toBe(
      true,
    );
  });

  it("does not let the base origin become a general escape hatch", () => {
    // Only the document itself, never some other page on the same host.
    expect(
      allowWatchNavigation({ url: `${WATCH_DOCUMENT_BASE_URL}/login`, isTopFrame: true }),
    ).toBe(false);
  });

  it("refuses a top-frame navigation to YouTube itself", () => {
    // The embed's "Watch on YouTube" affordance and its end cards both try this.
    // Allowing it would replace the synchronized player with a web page.
    expect(
      allowWatchNavigation({ url: "https://www.youtube.com/watch?v=x", isTopFrame: true }),
    ).toBe(false);
    expect(allowWatchNavigation({ url: `${YOUTUBE_EMBED_ORIGIN}/embed/x`, isTopFrame: true })).toBe(
      false,
    );
  });

  it("refuses every other scheme in the top frame", () => {
    expect(allowWatchNavigation({ url: "https://example.com", isTopFrame: true })).toBe(false);
    expect(allowWatchNavigation({ url: "intent://evil", isTopFrame: true })).toBe(false);
    expect(allowWatchNavigation({ url: "file:///etc/passwd", isTopFrame: true })).toBe(false);
  });

  it("lets the embed move around inside its own subframes", () => {
    // Consent, ads and related-video machinery all navigate subframes. A rule
    // strict enough to be interesting here would break playback instead; the
    // containment for those is the document CSP.
    expect(
      allowWatchNavigation({ url: "https://www.google.com/consent", isTopFrame: false }),
    ).toBe(true);
  });

  it("treats a missing isTopFrame as the top frame", () => {
    // Fail CLOSED: if a platform stops reporting the flag, the guard must not
    // silently start allowing arbitrary top-frame navigation.
    expect(allowWatchNavigation({ url: "https://example.com" })).toBe(false);
    expect(allowWatchNavigation({ url: "about:blank" })).toBe(true);
  });
});

describe("the relay speaks the parser's language", () => {
  it("forwards a frame that parsePlayerMessage understands", () => {
    // The relay stringifies non-string data before handing it to RN. Both shapes
    // must survive the round trip the player performs on `onMessage`.
    const asString = JSON.stringify({ event: "onStateChange", info: 1 });
    expect(parsePlayerMessage(asString)).toEqual({
      kind: "state",
      playerState: 1,
      currentTime: null,
      duration: null,
    });
  });
});
