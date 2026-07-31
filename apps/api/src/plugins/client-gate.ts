import type { FastifyInstance } from "fastify";
import {
  CLIENT_SIGNATURE_HEADER,
  CLIENT_UPDATE_DOWNLOAD_URL,
  CLIENT_UPDATE_REQUIRED_STATUS,
  isValidClientSignature,
} from "@demli/config";
import { errorBody } from "../errors.js";

/**
 * The HTTP half of the client-identity gate.
 *
 * See `@demli/config`'s `client-gate.ts` for WHY the mark exists and why its
 * absence is the signal. This file is only about WHERE the rule is applied.
 *
 * It is a global `onRequest` hook, which is the earliest per-request point
 * Fastify offers — deliberately BEFORE authentication, so an old client cannot
 * even sign in. Refusing only the authenticated surface would leave a working
 * login on a client we have decided must stop working.
 *
 * The gate is ARMED BY ENV and defaults to disarmed (`CLIENT_GATE` unset ⇒ every
 * request passes untouched). It ships dark and is switched on in
 * phase 2, alone, after the new apps are out.
 */

/**
 * Paths the gate must never touch, and why each one would break if it did.
 *
 * THIS LIST IS THE ESCAPE HATCH. Everything on it is something a client needs
 * BEFORE it can possibly satisfy the gate. Remove an entry and the gate stops
 * being a migration step and becomes a dead end — the client is refused, and the
 * information it would need in order to stop being refused is behind the same
 * refusal.
 */
const EXEMPT_PATHS = new Set([
  // Liveness. Used by the container healthcheck, the deploy verification and
  // every "is the server up" curl. Gating it would make a healthy server look
  // dead to its own orchestration.
  "/health",
  // The native-update advertisement. This is the single route that tells an old
  // install where to go; behind the gate, an old client is refused and can never
  // learn what to install. Called pre-auth on every cold launch, and by a client
  // that may be mid-update and not yet sending the mark. Non-negotiable.
  "/mobile/version",
]);

/**
 * Path PREFIXES exempt from the gate.
 *
 * `/hooks/*` is the EAS Build webhook: a machine caller that will never send a
 * client mark, and which authenticates itself with its own HMAC signature. The
 * gate has nothing to add there and would only break APK delivery.
 */
const EXEMPT_PREFIXES = ["/hooks/"];

/** Strip the query string; the gate matches on path only. */
function pathOf(url: string): string {
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

/** True when this request must bypass the gate entirely. */
export function isGateExempt(method: string, url: string): boolean {
  // CORS preflight. A browser sends OPTIONS with NO custom headers — that is the
  // whole point of a preflight, it is asking whether the header is allowed. Gate
  // it and the web app cannot make a single cross-origin call, including the
  // exempt ones above.
  if (method === "OPTIONS") return true;
  const path = pathOf(url);
  if (EXEMPT_PATHS.has(path)) return true;
  return EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Install the gate. No-op unless `env.clientGate` is true, so this is safe to
 * register unconditionally (and IS registered unconditionally — a gate you have
 * to remember to wire is a gate that is not wired).
 */
export function registerClientGate(server: FastifyInstance): void {
  server.addHook("onRequest", async (request, reply) => {
    if (!server.apiEnv.clientGate) return;
    if (isGateExempt(request.method, request.url)) return;
    if (isValidClientSignature(request.headers[CLIENT_SIGNATURE_HEADER])) return;

    return reply
      .status(CLIENT_UPDATE_REQUIRED_STATUS)
      .send(
        errorBody(
          "CLIENT_UPDATE_REQUIRED",
          "This version of Demli is no longer supported. Please install the current app to continue.",
          undefined,
          { downloadUrl: CLIENT_UPDATE_DOWNLOAD_URL },
        ),
      );
  });
}
