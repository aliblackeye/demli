import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { User } from "@demli/types";
import type { Repositories } from "@demli/db";
import { hashSessionToken } from "@demli/db";
import type { ApiEnv } from "../env.js";
import { ApiError } from "../errors.js";
import { parseBearerToken } from "../lib/auth-header.js";
import { LastSeenThrottle } from "../lib/last-seen-throttle.js";

declare module "fastify" {
  interface FastifyInstance {
    repos: Repositories;
    apiEnv: ApiEnv;
    /** preHandler enforcing a valid Bearer session token. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    currentUser: User | null;
    sessionTokenHash: string | null;
    /** Id of the session that authenticated this request (M15-A); null if none. */
    currentSessionId: string | null;
  }
}

/** Use inside authenticated handlers; narrows currentUser to User. */
export function requireUser(request: FastifyRequest): User {
  if (!request.currentUser) {
    throw new ApiError(401, "UNAUTHORIZED", "Sign in to continue.");
  }
  return request.currentUser;
}

export function requireSessionTokenHash(request: FastifyRequest): string {
  if (!request.sessionTokenHash) {
    throw new ApiError(401, "UNAUTHORIZED", "Sign in to continue.");
  }
  return request.sessionTokenHash;
}

/** Use inside authenticated handlers; narrows the current session id (M15-A). */
export function requireSessionId(request: FastifyRequest): string {
  if (!request.currentSessionId) {
    throw new ApiError(401, "UNAUTHORIZED", "Sign in to continue.");
  }
  return request.currentSessionId;
}

export function registerAuthDecorations(server: FastifyInstance): void {
  server.decorateRequest("currentUser", null);
  server.decorateRequest("sessionTokenHash", null);
  server.decorateRequest("currentSessionId", null);

  // Throttles the `last_seen_at` bump so the auth hot path writes at most once
  // per window per session (§27). One instance per app (this runs once at boot).
  const lastSeen = new LastSeenThrottle();

  server.decorate("authenticate", async (request: FastifyRequest) => {
    const token = parseBearerToken(request.headers.authorization);
    if (!token) {
      throw new ApiError(401, "UNAUTHORIZED", "Sign in to continue.");
    }
    const tokenHash = hashSessionToken(token);
    const active = await server.repos.sessions.findActiveByTokenHash(tokenHash);
    if (!active) {
      throw new ApiError(401, "UNAUTHORIZED", "Your session has expired. Sign in again.");
    }
    request.currentUser = active.user;
    request.sessionTokenHash = tokenHash;
    request.currentSessionId = active.session.id;

    // Best-effort freshness (M15-A): bump last_seen_at, throttled, and never let
    // a hiccup on this bookkeeping write fail the actual request.
    if (lastSeen.shouldTouch(active.session.id)) {
      try {
        await server.repos.sessions.touchLastSeen(active.session.id);
      } catch (err) {
        request.log.warn({ err }, "failed to bump session last_seen_at");
      }
    }
  });
}
