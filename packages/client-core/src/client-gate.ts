/**
 * The client gate — "this build is no longer allowed to talk to the server".
 *
 * ## Why this exists
 *
 * Demli's installed identity is moving (Android package id, Electron appId). A
 * new install is, to the operating system, a DIFFERENT application: the
 * auto-update bridge between the old and the new one is cut. So the old build
 * has to be retired deliberately, and the server is the only thing that can do
 * it — which it does by refusing every request that does not carry the new
 * client marker:
 *
 *   - HTTP  → `426 Upgrade Required`, body `CLIENT_UPDATE_REQUIRED` (+ an
 *             optional `downloadUrl` naming where the new build lives).
 *   - WS    → close code `4426` (the private 4xxx range, alongside the existing
 *             `4401` for a dead session token).
 *
 * ONE module recognises both, because they are one event with two transports: a
 * client that is refused over HTTP is refused over the socket in the same
 * breath, and both must land on the same screen. Desktop and mobile import from
 * here rather than each re-deriving "does 426 mean me" (ADR 0002).
 *
 * ## Shape rules
 *
 * - Framework-, DOM- and Node-free, and it imports NOTHING — not even
 *   `ApiClientError`. The error reader duck-types instead, which keeps the
 *   dependency arrow one-way (api-client → client-gate) and lets any caller
 *   hand in whatever error object it holds.
 * - `downloadUrl` is only ever accepted as an absolute `https://` address. It
 *   comes off the wire and ends up in "open this outside the app", so a
 *   `javascript:` or plaintext value must never survive the read (CLAUDE.md §28).
 */

/** HTTP status the server answers an unsupported client with. */
export const CLIENT_UPDATE_REQUIRED_STATUS = 426;

/** Error code carried in the 426 body (and the typed `ApiClientError.code`). */
export const CLIENT_UPDATE_REQUIRED_CODE = "CLIENT_UPDATE_REQUIRED";

/**
 * Gateway close code for the same refusal. 4426 mirrors the HTTP status inside
 * the private 4000-4999 range, next to `4401` (dead session token).
 */
export const CLIENT_UPDATE_REQUIRED_CLOSE_CODE = 4426;

/** Which transport reported the refusal — the UI copy is identical for both. */
export type ClientUpdateSource = "http" | "websocket";

/** A recognised refusal: this build must be replaced before it can be used. */
export interface ClientUpdateRequired {
  source: ClientUpdateSource;
  /**
   * Absolute `https://` address of the replacement build when the server named
   * one, else null. Clients have their own baked-in download link and use this
   * only when it is present — the server is allowed to redirect the migration,
   * it is not required to.
   */
  downloadUrl: string | null;
}

/** True for the one HTTP status that means "replace this build". */
export function isClientUpdateRequiredStatus(status: unknown): boolean {
  return status === CLIENT_UPDATE_REQUIRED_STATUS;
}

/** True for the one gateway close code that means "replace this build". */
export function isClientUpdateRequiredCloseCode(code: unknown): boolean {
  return code === CLIENT_UPDATE_REQUIRED_CLOSE_CODE;
}

/** An absolute `https://` url, or null for anything else (see header). */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" ? trimmed : null;
}

/**
 * Pull the replacement-build address out of a 426 response body.
 *
 * Two body shapes are accepted on purpose: the API's standard envelope
 * (`{ error: { code, message, downloadUrl } }`) and the flat form the gate
 * itself is specified with (`{ error: "CLIENT_UPDATE_REQUIRED", downloadUrl }`).
 * A gate that only understood one of them would silently drop the link.
 */
export function readClientUpdateDownloadUrl(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as { downloadUrl?: unknown; error?: unknown };
  const flat = httpsUrl(body.downloadUrl);
  if (flat !== null) return flat;
  if (typeof body.error === "object" && body.error !== null) {
    return httpsUrl((body.error as { downloadUrl?: unknown }).downloadUrl);
  }
  return null;
}

/**
 * Recognise a thrown API error as the gate's refusal.
 *
 * Duck-typed rather than `instanceof ApiClientError` (see header). EITHER
 * signal is enough: the status alone is decisive even when the body is empty or
 * not JSON, and the code alone covers a proxy that rewrote the status.
 */
export function readClientUpdateRequired(err: unknown): ClientUpdateRequired | null {
  if (typeof err !== "object" || err === null) return null;
  const candidate = err as { code?: unknown; status?: unknown; details?: unknown };
  const matches =
    isClientUpdateRequiredStatus(candidate.status) ||
    candidate.code === CLIENT_UPDATE_REQUIRED_CODE;
  if (!matches) return null;
  return { source: "http", downloadUrl: readClientUpdateDownloadUrl(candidate.details) };
}

/** Recognise a websocket close code as the gate's refusal. */
export function readClientUpdateRequiredClose(code: unknown): ClientUpdateRequired | null {
  if (!isClientUpdateRequiredCloseCode(code)) return null;
  // A close frame carries no body, so the client falls back to its own link.
  return { source: "websocket", downloadUrl: null };
}

/**
 * The latched "we have been refused" signal.
 *
 * LATCHED on purpose: the refusal is a property of the BUILD, not of one
 * request. Once the server has turned this binary away there is nothing the
 * user can do inside it, so clearing the flag on the next successful call
 * (there will not be one) or on a screen change would only flicker the refusal
 * in and out. `reset()` exists for tests, not for the app.
 *
 * NOTE (2026-07-31): today no surface binds this holder. Both apps consume the
 * refusal through the transport callbacks instead — `onClientUpdateRequired`
 * (HTTP 426) and the 4426 close reader — and render it as the typed
 * `errors.clientUpdateRequired` message. The holder stays because it is the
 * only shape that can outlive a single request if a surface later needs a
 * persistent "this build is retired" screen; it is framework-free so a zustand
 * store (desktop) and a React state hook (mobile) could both bind it.
 */
export interface ClientGate {
  /** The refusal, or null while the build is still accepted. */
  get(): ClientUpdateRequired | null;
  /** Record a refusal. Idempotent; a later report may only ADD a downloadUrl. */
  report(info: ClientUpdateRequired): void;
  /** Subscribe to changes; returns an unsubscribe function. */
  subscribe(listener: (info: ClientUpdateRequired) => void): () => void;
  /**
   * Test seam — clears the latch.
   *
   * Subscribers are deliberately KEPT: a binding would be set up once at import
   * time (a store binding, a hook), so dropping listeners here would silently
   * disconnect it for every test after the first — and the tests would still
   * pass while the wiring they were meant to prove was gone.
   */
  reset(): void;
}

export function createClientGate(): ClientGate {
  let current: ClientUpdateRequired | null = null;
  const listeners = new Set<(info: ClientUpdateRequired) => void>();

  return {
    get: () => current,
    report(info) {
      if (current !== null) {
        // Already latched. The only thing worth taking from a repeat is a
        // download address we did not have (the socket close carries none).
        if (current.downloadUrl !== null || info.downloadUrl === null) return;
        current = { ...current, downloadUrl: info.downloadUrl };
      } else {
        current = info;
      }
      const snapshot = current;
      for (const listener of [...listeners]) listener(snapshot);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      current = null;
    },
  };
}

/**
 * A process-wide holder for surfaces that want the latched signal rather than
 * the per-request callback. Nothing binds it today (see the note above); it is
 * one line and the only piece that can hold the refusal across requests.
 */
export const clientGate: ClientGate = createClientGate();
