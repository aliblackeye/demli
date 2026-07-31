/**
 * The mobile transport for the YouTube embed's `postMessage` API (M20, mobile
 * parity wave).
 *
 * ## What is different from desktop, and what is deliberately identical
 *
 * On desktop the renderer OWNS a `window`, so it can hold an `<iframe>` ref and
 * call `frame.contentWindow.postMessage(payload, YOUTUBE_EMBED_ORIGIN)` directly,
 * and read replies from a `window.addEventListener("message", …)`. React Native
 * has no DOM at all: the only thing it can address is a `<WebView>`, and the only
 * two verbs it has are "run this JavaScript inside it" and "receive a string from
 * it". So the wire gains exactly one hop:
 *
 *     RN  --injectJavaScript-->  our document  --postMessage-->  YouTube frame
 *     RN  <--onMessage--------  our document  <--message------  YouTube frame
 *
 * Everything ELSE is the same file's rules as
 * `apps/desktop/src/renderer/src/components/WatchPartyPlayer.tsx`, and the frames
 * on the wire are built by the SAME `@demli/client-core` helpers
 * (`listeningFrame`, `playCommand`, `seekCommand`, `parsePlayerMessage`, …). This
 * module adds transport, never protocol.
 *
 * ## Origin discipline — both directions, same strings as desktop
 *
 * 1. **Outbound.** {@link postToPlayerScript} posts with an explicit
 *    `targetOrigin` of {@link YOUTUBE_EMBED_ORIGIN}. Never `"*"`, which would
 *    hand our frames to whatever happens to be in the iframe.
 * 2. **Inbound.** The relay in {@link watchPlayerHtml} drops every `message`
 *    event unless `event.origin` is exactly that origin AND `event.source` is the
 *    iframe's own `contentWindow`. Anything else never reaches React Native.
 * 3. **The document itself** carries a CSP that permits NOTHING except framing
 *    that one host. Our page loads no script, no style, no image, no font and no
 *    connection of its own — it is a shell around one frame, and the CSP says so
 *    in a line a reviewer can diff against the desktop `frame-src` by eye.
 *
 * The document is served to the WebView as inline HTML with no base URL, so its
 * origin is opaque ("null"). That is the same footing the desktop renderer runs
 * on (`file://`), which is why {@link buildEmbedUrl} deliberately omits the
 * `origin` parameter — an opaque origin handed to YouTube breaks the handshake
 * outright.
 */

import { commandFrame, YOUTUBE_EMBED_ORIGIN } from "@demli/client-core";

/**
 * The origin our player document is loaded under.
 *
 * ## Why the document needs an origin at all
 *
 * Measured on the emulator, 2026-07-29: with no base URL, Android WebView loads
 * inline HTML at an OPAQUE origin and sends NO `Referer`. The embed then refuses
 * to play with **error 153** — "video player configuration error", YouTube's
 * response to a request it cannot attribute to any site. Nothing else was wrong:
 * the frame loaded, the relay worked, and the refusal arrived through our own
 * bridge and rendered as the §26 playback error. The player simply will not play
 * for a page that is nowhere.
 *
 * Desktop does not hit this because its renderer runs from `file://`, which the
 * embed still accepts. It is a WebView-only difference in what the platform puts
 * on the wire, so the fix belongs here in the transport and not in the shared
 * `buildEmbedUrl` — which deliberately sends no `origin` PARAMETER, because
 * handing YouTube an opaque origin breaks the API handshake outright.
 *
 * ## Why OUR origin, and specifically not YouTube's
 *
 * The obvious fix — and what most RN YouTube wrappers do — is to claim
 * `https://www.youtube.com`. That works, and it quietly opens a hole: the embed
 * navigates its own subframes to `youtube.com` during normal playback (consent,
 * ads), and any such subframe would then be SAME-ORIGIN with our document. It
 * could reach `parent.window.ReactNativeWebView.postMessage` directly — around
 * the relay, past both of its checks — and forge player frames: a fake `ended`
 * that skips the room's video, a fake position that drives drift correction.
 *
 * Our own web origin costs nothing extra (any attributable referrer satisfies
 * the embed) and keeps every YouTube frame cross-origin, so `postMessage` with
 * its origin+source checks stays the only way in. Nothing is fetched from this
 * host — the document is inline and its CSP is `default-src 'none'` — so the
 * string is an identity, not a dependency, and the page works offline.
 */
export const WATCH_DOCUMENT_BASE_URL = "https://app.getdemli.com";

/**
 * Set the embed's volume, 0–100.
 *
 * Built from client-core's generic {@link commandFrame} rather than added to it:
 * the shared module owns the frames BOTH platforms send, and this one is
 * mobile-only. On desktop the film's loudness is a mixer problem the OS solves —
 * the user drags the app's slider in the volume mixer. A phone has one volume
 * rocker and it is already spoken for by the call, so the only lever that can
 * make the film quieter WITHOUT touching the VoIP audio path is the player's own
 * volume. See {@link WatchPartyPlayer} for why touching the audio path is off the
 * table.
 */
export function volumeCommand(volumePercent: number): string {
  const clamped = Math.min(100, Math.max(0, Math.round(volumePercent)));
  return commandFrame("setVolume", [clamped]);
}

/**
 * The JS to run inside the WebView to forward one frame to the embed.
 *
 * `payload` is already a JSON string from client-core, and it is embedded with
 * `JSON.stringify`, which produces a properly escaped JavaScript string literal —
 * so a payload can never break out of the expression it is placed in. The
 * trailing `true;` is required by `injectJavaScript`: without a primitive result
 * iOS logs a warning on every call, and this one is called several times a second.
 */
export function postToPlayerScript(payload: string): string {
  return `window.__tcWatchPost && window.__tcWatchPost(${JSON.stringify(payload)}); true;`;
}

/** Minimal HTML attribute escaping for the one interpolated value below. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The document the WebView loads: one full-bleed iframe and the relay.
 *
 * `embedSrc` comes from {@link buildEmbedUrl}, which returns null for anything
 * that is not a valid 11-character video id — so this function is only ever
 * called with a URL that already passed that gate, and it escapes the value for
 * the attribute regardless. A `videoId` is server-sent and the server stores
 * nothing else, but "unreachable" is not a security argument.
 *
 * The relay is inline rather than injected through
 * `injectedJavaScriptBeforeContentLoaded` so it cannot race the iframe: it is
 * parsed with the document, and `window.ReactNativeWebView` is already present by
 * the time any script in the body runs.
 */
export function watchPlayerHtml(embedSrc: string): string {
  const src = escapeAttribute(embedSrc);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${YOUTUBE_EMBED_ORIGIN}; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
  iframe { display: block; border: 0; width: 100%; height: 100%; }
</style>
</head>
<body>
<iframe
  id="tc-yt"
  src="${src}"
  allow="autoplay; encrypted-media; picture-in-picture"
  allowfullscreen
></iframe>
<script>
(function () {
  var ORIGIN = ${JSON.stringify(YOUTUBE_EMBED_ORIGIN)};
  var frame = document.getElementById('tc-yt');

  // Outbound. The ONLY way React Native reaches the embed; an explicit
  // targetOrigin, never "*".
  window.__tcWatchPost = function (payload) {
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage(payload, ORIGIN);
    } catch (e) {
      // A frame mid-navigation can throw. Swallowing is correct: this runs from
      // an interval on the RN side, and a throw here would be reported as a
      // WebView error for something that self-corrects on the next tick.
    }
  };

  // Inbound. Two gates, both required, both matching the desktop listener:
  // exactly our embed origin, and exactly our own frame's window.
  window.addEventListener('message', function (event) {
    if (event.origin !== ORIGIN) return;
    if (!frame || event.source !== frame.contentWindow) return;
    if (!window.ReactNativeWebView) return;
    var data = event.data;
    window.ReactNativeWebView.postMessage(
      typeof data === 'string' ? data : JSON.stringify(data)
    );
  });
})();
</script>
</body>
</html>`;
}

/**
 * Whether the WebView may load `url` in its TOP frame.
 *
 * The mobile counterpart of the desktop main process's `will-frame-navigate`
 * guard. React Native Webview asks this for every navigation and tells us whether
 * it is the top frame, so the rule splits the same way:
 *
 *  - TOP frame — only the document WE handed it. That document is loaded with
 *    {@link WATCH_DOCUMENT_BASE_URL} as its base, so the platform reports the
 *    initial load as that URL (and, on some versions, as `about:blank` or a
 *    `data:` URL) — all three are permitted and nothing else is. A top-frame
 *    navigation to YouTube (the embed's "Watch on YouTube" affordance, a tapped
 *    end-card) would replace our player with a full web page inside the app, and
 *    that is precisely what must not happen.
 *  - SUBFRAME — allowed. The embed navigates its own subframes constantly
 *    (consent, ads, related-video machinery) and a rule strict enough to be
 *    interesting here would break playback instead. Containment for the subframe
 *    is the document CSP above, which is the same containment desktop relies on.
 *
 * Returning false CANCELS the navigation; it is never re-opened externally. A
 * frame navigating itself is not a user asking to visit a page, and treating it
 * as one would turn the embed into a launcher for arbitrary URLs.
 */
export function allowWatchNavigation(request: {
  url: string;
  isTopFrame?: boolean;
}): boolean {
  if (request.isTopFrame === false) return true;
  return (
    request.url.startsWith("about:") ||
    request.url.startsWith("data:") ||
    request.url === WATCH_DOCUMENT_BASE_URL ||
    request.url === `${WATCH_DOCUMENT_BASE_URL}/`
  );
}
