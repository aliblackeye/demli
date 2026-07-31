/**
 * Token liveness probe (ADR 0013 hardening — P0 #100).
 *
 * An account switch pivots the live session onto a STORED token. If that token
 * was invalidated server-side while it sat in the vault (the account was logged
 * out elsewhere, or "sign out all other sessions" hit it), pivoting blind means
 * every post-pivot request 401s — the realtime gateway then fires `onAuthExpired`
 * → the app dumps the user to the "session expired" login screen AND tears down
 * the perfectly-good session they were on. Worst-possible UX.
 *
 * The fix is to PROBE the target token before committing to the pivot: a cheap,
 * read-only `GET /users/me` with the target's bearer, made WITHOUT touching the
 * live api client (its own token, socket, and cache stay untouched). Three
 * outcomes drive the switch decision:
 *
 *   - `valid`       → 200; the token authenticates. Proceed with the switch.
 *   - `invalid`     → 401; the token is dead. Do NOT pivot; re-auth instead.
 *   - `unreachable` → network failure, timeout, or any other/ambiguous status
 *                     (403 / 5xx / …). Do NOT pivot on an unclear answer — keep
 *                     the user where they are and let them retry.
 *
 * Framework-free and DOM-only (global `fetch` + `AbortController`, present in the
 * browser, the Electron renderer, and React Native alike). Both `baseUrl` and the
 * `fetch` impl are injected so the platform passes its own (desktop VITE_API_URL /
 * mobile EXPO_PUBLIC_API_URL) and tests pass a stub.
 */

/** The outcome of {@link probeAccountToken}. */
export type TokenProbeResult = "valid" | "invalid" | "unreachable";

/**
 * The subset of the global `fetch` this probe needs — narrowed so a test can pass
 * a trivial stub and so React Native's `fetch` satisfies it. The real global
 * `fetch` is assignable to it.
 */
export type ProbeFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number }>;

export interface TokenProbeOptions {
  /** API base URL with no trailing slash (e.g. https://api.getdemli.com). */
  baseUrl: string;
  /** The stored token to test — never the live client's current token. */
  token: string;
  /** Abort the probe after this many ms (default 6000). <= 0 disables the guard. */
  timeoutMs?: number;
  /** Injected fetch (defaults to the global). Tests pass a stub. */
  fetchImpl?: ProbeFetch;
}

/** Default probe deadline: long enough for a slow phone network, short enough not to hang the switch. */
export const DEFAULT_TOKEN_PROBE_TIMEOUT_MS = 6_000;

/**
 * Test whether `token` still authenticates against `baseUrl`, WITHOUT mutating any
 * live client state. Never throws — every failure mode collapses to a
 * {@link TokenProbeResult}, so the caller can branch on three cases only.
 */
export async function probeAccountToken(options: TokenProbeOptions): Promise<TokenProbeResult> {
  const { baseUrl, token } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOKEN_PROBE_TIMEOUT_MS;
  const doFetch: ProbeFetch = options.fetchImpl ?? (fetch as unknown as ProbeFetch);

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await doFetch(`${baseUrl}/users/me`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (response.status === 200) return "valid";
    if (response.status === 401) return "invalid";
    // Any other status (403 / 429 / 5xx / …) is ambiguous — treat it like a
    // reachability failure so we never tear down the current session on a token
    // that might well be fine.
    return "unreachable";
  } catch {
    // Transport failure, DNS/TLS error, or the AbortError from our timeout.
    return "unreachable";
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
