import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RealtimeMutationPublisher, Session } from "@demli/db";
import { serverEvent } from "@demli/protocol";
import type { SessionSummary } from "@demli/types";
import { ApiError, parseWith } from "../../errors.js";
import { requireSessionId, requireUser } from "../../plugins/auth.js";
import { userRateLimit } from "../../lib/rate-limit.js";

/**
 * Active-session management (M15-A) — the "where you're signed in" screen.
 *
 * - `GET    /sessions`          — the caller's own unexpired sessions, newest
 *                                 active first, with `current` flagging the one
 *                                 that made the request.
 * - `DELETE /sessions/others`   — sign out every OTHER session (keep this one).
 * - `DELETE /sessions/:id`      — close ONE session the caller owns.
 *
 * Every route is session-authenticated and scoped to the caller's own rows
 * (§28): the revoke helpers filter on `user_id`, so one user can never see or
 * close another's session — a foreign/unknown id answers 404 without confirming
 * it exists. Closing a session drops its token hash, so the very next request
 * bearing that token fails auth (401). The token hash itself is never emitted —
 * the response DTO omits it.
 *
 * Immediate kick (#98): dropping the token hash only stops the NEXT HTTP request;
 * a live WebSocket (and any screen-share it carries) would otherwise linger until
 * then. So each successful revoke ALSO publishes a user-scoped `session.revoked`
 * on the mutation bus carrying the revoked ids; the realtime gateway forwards it
 * to the matching live connections and closes them at once (4401). Best-effort —
 * the DB delete is the source of truth, so a failed publish never fails the HTTP
 * request (mirrors the social/notification-mute publishers).
 *
 * `DELETE /sessions/others` is registered as a STATIC route; find-my-way matches
 * it ahead of the parametric `/:id`, and the uuid guard on `:id` rejects any
 * stray non-uuid segment for good measure.
 */

const sessionIdParamsSchema = z.object({
  id: z.string().uuid("Invalid session id."),
});

/** Backend session row → public summary (drops the token hash; flags current). */
function toSummary(session: Session, currentSessionId: string): SessionSummary {
  return {
    id: session.id,
    deviceName: session.deviceName,
    platform: session.platform,
    lastSeenAt: session.lastSeenAt,
    createdAt: session.createdAt,
    current: session.id === currentSessionId,
  };
}

export async function registerSessionsModule(
  server: FastifyInstance,
  mutationBus?: RealtimeMutationPublisher,
): Promise<void> {
  // The caller's own active sessions, most-recently-active first.
  server.get(
    "/sessions",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 60, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const currentSessionId = requireSessionId(request);
      const rows = await server.repos.sessions.listForUser(user.id);
      return { sessions: rows.map((s) => toSummary(s, currentSessionId)) };
    },
  );

  // Sign out every OTHER session, keeping the current one alive. Static route —
  // matched ahead of `/:id`. Returns how many were closed so the UI can confirm.
  server.delete(
    "/sessions/others",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 20, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const currentSessionId = requireSessionId(request);
      // Capture the OTHER sessions' ids BEFORE revoking so we can name them in the
      // kick event — `revokeOthers` returns only a count. Any session created in
      // the tiny window between this read and the delete is still revoked by the
      // delete (source of truth); it just misses the instant WS kick and falls
      // back to the next-request 401 — an acceptable, rare edge.
      const otherIds = (await server.repos.sessions.listForUser(user.id))
        .map((s) => s.id)
        .filter((id) => id !== currentSessionId);
      const revoked = await server.repos.sessions.revokeOthers(user.id, currentSessionId);
      // Immediate kick of those sessions' live connections (best-effort, §98).
      if (otherIds.length > 0) {
        await mutationBus?.publish({
          userId: user.id,
          event: serverEvent.sessionRevoked({ sessionIds: otherIds }),
        });
      }
      return { revoked };
    },
  );

  // Close ONE session the caller owns. 404 (no leak) when the id is not one of
  // the caller's sessions; 204 on success. Closing the current session is
  // allowed (it simply logs this device out).
  server.delete(
    "/sessions/:id",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 20, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { id } = parseWith(sessionIdParamsSchema, request.params);
      const revoked = await server.repos.sessions.revoke(id, user.id);
      if (!revoked) {
        throw new ApiError(404, "NOT_FOUND", "Session not found.");
      }
      // Immediate kick (best-effort, §98): if this session has a live WS
      // connection (this device or another), the gateway closes it at once
      // rather than letting it survive to its next request. Closing the CURRENT
      // session is fine too — this device's own socket is dropped.
      await mutationBus?.publish({
        userId: user.id,
        event: serverEvent.sessionRevoked({ sessionIds: [id] }),
      });
      return reply.status(204).send();
    },
  );
}
