/**
 * Client-identity gate — the server-side kill switch for retired app builds.
 *
 * WHY THIS EXISTS
 * ---------------
 * A change to the Android package id or the Electron appId makes the result a
 * DIFFERENT APPLICATION to the operating system that installed it: the old
 * install is never upgraded in place, it sits beside the new one. Once the new
 * app is the real one, the old one must stop being able to talk to the server at
 * all — otherwise two apps keep the same account half-alive and every "why did
 * my message not arrive" is unanswerable.
 *
 * HOW OLD AND NEW ARE TOLD APART
 * ------------------------------
 * By a MARK the new clients send and the old ones cannot:
 *   - REST: the `x-demli-client: <app>/<version>` header, added once in
 *     `@demli/client-core`'s api client, so every new client (desktop, mobile,
 *     web) gets it without touching a call site.
 *   - WebSocket: the `?client=<app>/<version>` query param. A browser cannot set
 *     a custom header on a WS handshake, so the mark has to ride the URL; the
 *     `platform` param is the existing precedent.
 *
 * ABSENCE IS THE SIGNAL. Old builds never send it and never will — shipping them
 * an "identify yourself" update first would be a whole extra migration wave for
 * no gain. So the gate's rule is simply: no valid mark ⇒ old client.
 *
 * The format check is deliberately LOOSE (`demli-<app>/<something>`). This is not
 * version policy — it is an old/new discriminator, and a strict semver parse here
 * would be one more way to lock out a client we meant to keep.
 *
 * Lives in `@demli/config` because it is a rule the API (`apps/api`), the WS
 * gateway (`apps/realtime`) and the clients all have to agree on, and this is the
 * dependency-free leaf every one of them can import. Two copies of "what counts
 * as a new client" is exactly the drift that locks real users out.
 */

/** REST header carrying the client mark. Lowercase — Fastify normalizes headers. */
export const CLIENT_SIGNATURE_HEADER = "x-demli-client";

/** WebSocket handshake query param carrying the client mark. */
export const CLIENT_SIGNATURE_QUERY_PARAM = "client";

/** Env var that arms the gate. */
export const CLIENT_GATE_ENV_VAR = "CLIENT_GATE";

/** The ONLY value that opens the gate. Everything else means closed. */
export const CLIENT_GATE_ON_VALUE = "on";

/** HTTP status a gated request is refused with (426 Upgrade Required). */
export const CLIENT_UPDATE_REQUIRED_STATUS = 426;

/**
 * WebSocket close code for a gated handshake. In the application-private 4000+
 * range and deliberately parallel to the HTTP status, next to the existing
 * `CLOSE_UNAUTHORIZED = 4401`.
 */
export const CLIENT_UPDATE_REQUIRED_CLOSE_CODE = 4426;

/** Wire code both transports use; clients switch on this exact string. */
export const CLIENT_UPDATE_REQUIRED_CODE = "CLIENT_UPDATE_REQUIRED";

/** Where a refused client is sent to get the current app. */
export const CLIENT_UPDATE_DOWNLOAD_URL = "https://getdemli.com";

/**
 * `demli-<app>/<version>` — e.g. `demli-desktop/0.0.81`, `demli-mobile/2.0.0`,
 * `demli-web/1`. Loose by design (see the file header).
 */
const CLIENT_SIGNATURE_PATTERN = /^demli-[a-z]+\/\S+$/;

/**
 * Upper bound on the mark we will even look at. A header is attacker-controlled
 * input; capping it keeps the regex off unbounded strings.
 */
const CLIENT_SIGNATURE_MAX_LENGTH = 128;

/**
 * The surfaces that carry a mark. Closed on purpose: `[a-z]+` in the pattern
 * would accept anything, and a typo'd app name is indistinguishable from a real
 * one at the gate — it passes, and then nobody can tell which build is calling.
 */
export const CLIENT_APPS = ["desktop", "web", "mobile"] as const;

/** One of {@link CLIENT_APPS}. */
export type ClientApp = (typeof CLIENT_APPS)[number];

/**
 * What a version degrades to when the surface cannot read its own.
 *
 * NOT an error, and deliberately still a VALID mark: the version is diagnostic
 * only — the gate discriminates old from new on the mark's PRESENCE, so a build
 * that knows what it is but not which version it is must still get through. The
 * alternative (no mark at all) would lock out a current client over a missing
 * string, which is the one failure this whole mechanism exists to avoid.
 */
const UNKNOWN_VERSION = "0";

/**
 * Build the mark a client sends on every request.
 *
 * The version is normalised rather than trusted: whitespace inside it would
 * break the `\S+` shape, an empty string would produce `demli-web/` (invalid),
 * and an absurdly long one would blow the length cap — each of which turns a
 * healthy client into a refused one. Every such input collapses to
 * {@link UNKNOWN_VERSION} instead, so this function CANNOT return a value that
 * {@link isValidClientSignature} rejects.
 */
export function formatClientSignature(app: ClientApp, version: unknown): string {
  const prefix = `demli-${app}/`;
  const raw = typeof version === "string" ? version.trim() : "";
  // Collapse any internal whitespace: `\S+` must hold for the whole tail.
  const compact = raw.replace(/\s+/g, "-");
  const maxVersion = CLIENT_SIGNATURE_MAX_LENGTH - prefix.length;
  const safe =
    compact.length === 0 || compact.length > maxVersion ? UNKNOWN_VERSION : compact;
  return `${prefix}${safe}`;
}

/** True when `raw` is a well-formed client mark (see the pattern above). */
export function isValidClientSignature(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const value = raw.trim();
  if (value.length === 0 || value.length > CLIENT_SIGNATURE_MAX_LENGTH) return false;
  return CLIENT_SIGNATURE_PATTERN.test(value);
}

/**
 * True ONLY for the exact string `"on"` — byte for byte, no trimming, no case
 * folding.
 *
 * FAIL-SAFE BY CONSTRUCTION: unset, empty, `"true"`, `"1"`, `"ON"`, `"on "`, a
 * typo — every one of them leaves the gate CLOSED. The two failure modes are not
 * symmetric. Failing to arm leaves the product exactly as it is today and someone
 * notices within a minute of testing; arming by accident locks every real user
 * out of a live product. So the switch only ever turns on for the one literal
 * value, and every attempt at leniency here (trim, lowercase, truthiness) is a
 * way for something nobody typed on purpose to open it.
 */
export function isClientGateEnabled(raw: unknown): boolean {
  return raw === CLIENT_GATE_ON_VALUE;
}
