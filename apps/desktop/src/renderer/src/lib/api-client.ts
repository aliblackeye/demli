/**
 * Desktop HTTP-client wrapper. The typed client itself lives in the shared
 * `@demli/client-core` package (ADR 0002 — one wire implementation for
 * desktop + mobile); this file only injects the desktop's base URL and
 * re-exports the surface the renderer already imports, so no component churns.
 *
 * - Base URL comes from VITE_API_URL (see apps/desktop/.env.example).
 * - `setAuthToken` is bound to this instance's token and called by the auth
 *   store on session changes (see stores/auth-store.ts).
 */

import { createApiClient } from "@demli/client-core";
import { CLIENT_SIGNATURE } from "./client-signature";

// Re-export the shared transport surface (ApiClientError, friendlyErrorMessage,
// request DTOs, TokenStorage, createApiClient, RealtimeClient, …) so existing
// `../lib/api-client` imports keep resolving unchanged.
export * from "@demli/client-core";

/**
 * The API base URL this client is bound to. Exported so the account manager can
 * probe a STORED token's liveness (GET /users/me) before an account switch —
 * without mutating this client's own bearer (ADR 0013 hardening, P0 #100).
 */
export const apiBaseUrl =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:4000";

const client = createApiClient({
  baseUrl: apiBaseUrl,
  // The mark that tells the server's client gate this is a CURRENT build.
  // Resolved once at module load — `demli-desktop/<ver>` in Electron,
  // `demli-web/<ver>` in the browser (see ./client-signature.ts).
  clientSignature: CLIENT_SIGNATURE,
});

/** The typed API endpoint surface (same shape the renderer already used). */
export const api = client.api;

/** Called by the auth store whenever the session token changes. */
export const setAuthToken = client.setAuthToken;
