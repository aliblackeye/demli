/**
 * The rate-limit key and the route config that carries it.
 *
 * WHY THIS FILE EXISTS — every module used to declare its own copy of:
 *
 *     function perSessionKey(request) {
 *       return request.headers.authorization ?? request.ip;
 *     }
 *
 * i.e. the bucket was keyed on the SESSION TOKEN. That is not a limit on a
 * person, it is a limit on a credential, and credentials are free: `POST
 * /auth/login` mints a fresh token every call, so one account could hold N
 * sessions and get N independent buckets on every "per-session" route. The
 * limit divided by nothing and multiplied by however many times the attacker
 * felt like logging in. The identity that actually costs the server money is
 * the USER, so that is what the bucket is keyed on now.
 *
 * The IP fallback stays for the unauthenticated case only (and `trustProxy: 1`
 * in app.ts is what makes `request.ip` the real client address rather than
 * Caddy's). The two namespaces are PREFIXED so a user id can never collide with
 * an address — without the prefix, a key space shared between two different
 * kinds of identifier is one lookup away from a surprise.
 *
 * THE `hook` FIELD IS LOAD-BEARING. @fastify/rate-limit installs its check on
 * `onRequest` by default, which runs BEFORE the route's `preHandler`, i.e.
 * before `server.authenticate` has put anything on `request.currentUser` — the
 * key generator would see `null` on every single request and silently fall back
 * to the IP, collapsing every user behind one NAT into one bucket while leaving
 * every test green. Moving the check to `preHandler` appends it AFTER
 * `authenticate` in the route's own hook array, so the user is resolved by the
 * time the key is computed. That is why {@link userRateLimit} exists at all
 * rather than exporting the key function alone: the hook and the key generator
 * are one decision and must not be spellable apart.
 */

import type { FastifyRequest } from "fastify";

/** How a `config.rateLimit` object looks once this module has filled it in. */
export interface UserRateLimitConfig {
  max: number;
  timeWindow: string;
  hook: "preHandler";
  keyGenerator: (request: FastifyRequest) => string;
}

/**
 * Rate-limit key: the authenticated USER, falling back to the client IP when
 * there is no session (an unauthenticated route, or an authenticated one whose
 * limiter somehow ran before auth — see the `hook` note above).
 *
 * Not the session token: a token is a credential the caller can mint more of,
 * so keying on it lets one account multiply its own allowance by logging in
 * again. Not the raw IP either, for authenticated routes: a household or a
 * campus behind one NAT would share a single bucket.
 */
export function perUserKey(request: FastifyRequest): string {
  const userId = request.currentUser?.id;
  return userId ? `u:${userId}` : `ip:${request.ip}`;
}

/**
 * Build a per-user `config.rateLimit` for an AUTHENTICATED route.
 *
 * Use on every route whose `preHandler` includes `server.authenticate`. On a
 * route without it the key degrades to the IP, which is correct but is not what
 * this helper is for — an unauthenticated route should say `keyGenerator` and
 * its reasoning out loud instead.
 */
export function userRateLimit(options: {
  max: number;
  timeWindow: string;
}): UserRateLimitConfig {
  return {
    max: options.max,
    timeWindow: options.timeWindow,
    hook: "preHandler",
    keyGenerator: perUserKey,
  };
}

/**
 * Standard budgets for AUTHENTICATED GET routes.
 *
 * Every one of these reads was unlimited before, which meant a single account
 * could hold the database open for as long as it liked — the message list being
 * the expensive one (a blocked-author lookup plus three batched enrichment
 * queries, per call). The numbers below are deliberately far above real use;
 * they are an abuse ceiling, not a throttle, and none of them is a round number
 * chosen for looking tidy:
 *
 * - {@link READ_LIMIT} 300/min — small keyed reads (`/users/:id`,
 *   `/users/:id/profile`, `/users/me`). A member sidebar or a mention-heavy
 *   channel can fan out one of these per distinct user on screen, and a client
 *   that has just reconnected re-fetches them in a burst. 5/second sustained is
 *   comfortably past that.
 *
 * - {@link LIST_LIMIT} 120/min — collection reads that a screen fetches once and
 *   then refetches on focus/reconnect (`/groups`, `/dms`, `/friends`, the
 *   per-group channel/role/category/emoji lists). App boot fires roughly a dozen
 *   of these at once; 2/second sustained leaves an order of magnitude of room.
 *
 * - {@link MESSAGE_PAGE_LIMIT} 180/min — `GET /channels/:id/messages`, the
 *   heaviest read. Opening a channel is one call and scrolling back is one call
 *   per page, so a user speed-reading their way up a long history is the real
 *   worst case: 3 pages/second sustained for a full minute is far more than a
 *   human scroll can produce and still caps the query amplification.
 */
export const READ_LIMIT = { max: 300, timeWindow: "1 minute" } as const;
export const LIST_LIMIT = { max: 120, timeWindow: "1 minute" } as const;
export const MESSAGE_PAGE_LIMIT = { max: 180, timeWindow: "1 minute" } as const;
