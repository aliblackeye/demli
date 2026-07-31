/**
 * Frozen-account (soft-delete grace window) detection for the login flow (M15).
 *
 * A `POST /users/me/delete` freezes the account for 14 days; signing in during
 * that window answers `403 { error: { code: "ACCOUNT_FROZEN", purgeAt } }`, and
 * re-sending the SAME login with `reactivate: true` restores it. The shared
 * `ApiClientError` carries the raw HTTP status, the runtime error `code` (kept
 * OUT of the typed `ApiClientErrorCode` union so it stays additive — read it as a
 * string here), and the full parsed body on `.details`, from which we lift the
 * purge date to show the user how long they have left.
 */
import { ApiClientError } from "./clients";

/** The frozen-account details surfaced to the login screen; `purgeAt` may be absent. */
export interface FrozenAccountInfo {
  /** ISO instant the account is permanently deleted, when the server sent one. */
  purgeAt: string | null;
}

/**
 * If `err` is the frozen-account 403, return its info (with `purgeAt` when the
 * server included it); otherwise null. Detection is by HTTP 403 + the raw
 * `ACCOUNT_FROZEN` code, tolerant of the code not being in the typed union.
 */
export function frozenAccountInfo(err: unknown): FrozenAccountInfo | null {
  if (!(err instanceof ApiClientError)) return null;
  if (err.status !== 403) return null;
  if ((err.code as string) !== "ACCOUNT_FROZEN") return null;
  const details = err.details as { error?: { purgeAt?: unknown } } | null;
  const purgeAt = details?.error?.purgeAt;
  return { purgeAt: typeof purgeAt === "string" ? purgeAt : null };
}
