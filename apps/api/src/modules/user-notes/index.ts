/**
 * Private per-viewer annotations (migration 0020, ADR 0019 §1–2) — the two
 * right-click actions that are about ONE person's private view of another.
 *
 * Routes:
 *   GET    /users/:id/note        my note about them (never theirs about me)
 *   PUT    /users/:id/note        write it; `body: null` or empty deletes it
 *   PUT    /users/:id/nickname    my PRIVATE nickname for them; null clears
 *   GET    /users/me/nicknames    every private nickname I have set (bulk sync)
 *
 * **The privacy rule, stated once:** everything in this module is scoped to
 * `viewer_id = the caller`. There is no route here that takes a viewer id, no
 * route that lists notes about a user, and no field added to any profile,
 * roster, message or realtime payload elsewhere. The target of a note cannot
 * reach it through any endpoint in the codebase — that is asserted by
 * `apps/api/src/__tests__/user-notes.int.test.ts`, which drives the target's own
 * token against every plausible read and expects nothing back.
 *
 * Note that the PRIVATE nickname here is NOT the per-server nickname — that one
 * is public to a whole server and lives in `modules/members`. The ADR explains
 * why Demli has both; the short version is that "what I call
 * you" and "what this server calls you" are different facts with different
 * audiences, and collapsing them would publish one user's private label.
 *
 * Realtime: `user.nickname_updated`, USER-scoped to the VIEWER's own devices, so
 * a rename on desktop reaches the same account's phone. There is deliberately NO
 * event for a note — it renders in exactly one place, which fetches it on open,
 * so putting private text on a fan-out bus would buy nothing.
 */

import type { FastifyInstance } from "fastify";
import type { RealtimeMutationPublisher } from "@demli/db";
import {
  serverEvent,
  setUserNicknameBodySchema,
  setUserNoteBodySchema,
  userParamsSchema,
} from "@demli/protocol";
import { ApiError, parseWith } from "../../errors.js";
import { requireUser } from "../../plugins/auth.js";
import { LIST_LIMIT, READ_LIMIT, userRateLimit } from "../../lib/rate-limit.js";

/**
 * Shared budget for the private-annotation writes. 30/min is far above any human
 * editing rate while stopping a scripted session from using these tables as free
 * per-user storage — the rows are unbounded text keyed by a pair of ids, which is
 * exactly the shape someone would abuse if it were unmetered.
 */
const ANNOTATION_RATE_LIMIT = userRateLimit({ max: 30, timeWindow: "1 minute" });

export async function registerUserNotesModule(
  server: FastifyInstance,
  mutationBus?: RealtimeMutationPublisher,
): Promise<void> {
  // --- The note: read ------------------------------------------------------
  //
  // Scoped to the caller by construction — `viewerId` is the session's user and
  // is never taken from the request. A user asking for "the note on X" always
  // gets THEIR note on X, and there is no way to phrase the other question.
  server.get(
    "/users/:id/note",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(READ_LIMIT) },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = parseWith(userParamsSchema, request.params);
      return { note: await server.repos.userNotes.getNote(user.id, id) };
    },
  );

  // --- The note: write / clear ---------------------------------------------
  server.put(
    "/users/:id/note",
    { preHandler: [server.authenticate], config: { rateLimit: ANNOTATION_RATE_LIMIT } },
    async (request) => {
      const user = requireUser(request);
      const { id } = parseWith(userParamsSchema, request.params);
      const body = parseWith(setUserNoteBodySchema, request.body);

      if (id === user.id) {
        throw new ApiError(400, "VALIDATION_ERROR", "You cannot write a note about yourself.");
      }

      // "Empty means clear" — the same rule the custom status uses. The schema
      // has already sanitized, so a body of only whitespace or invisible
      // characters arrives here as "", and deleting is the honest response to it
      // rather than storing a row that renders as nothing.
      if (body.body === null || body.body.length === 0) {
        await server.repos.userNotes.clearNote(user.id, id);
        return { note: null };
      }

      // The target must exist. Not an enumeration concern: this is an
      // authenticated, rate-limited write against a uuid the caller already holds
      // from a profile card, so a 404 discloses nothing a profile fetch would not.
      const target = await server.repos.users.findById(id);
      if (!target) throw new ApiError(404, "NOT_FOUND", "User not found.");

      const note = await server.repos.userNotes.setNote(user.id, id, body.body);
      if (!note) {
        throw new ApiError(400, "VALIDATION_ERROR", "You cannot write a note about yourself.");
      }
      return { note };
    },
  );

  // --- The PRIVATE nickname: write / clear ---------------------------------
  server.put(
    "/users/:id/nickname",
    { preHandler: [server.authenticate], config: { rateLimit: ANNOTATION_RATE_LIMIT } },
    async (request) => {
      const user = requireUser(request);
      const { id } = parseWith(userParamsSchema, request.params);
      const body = parseWith(setUserNicknameBodySchema, request.body);

      if (id === user.id) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "You cannot nickname yourself. Change your display name instead.",
        );
      }

      if (body.nickname === null) {
        await server.repos.userNotes.clearNickname(user.id, id);
        await publishNickname(mutationBus, user.id, id, null);
        return { nickname: null };
      }

      const target = await server.repos.users.findById(id);
      if (!target) throw new ApiError(404, "NOT_FOUND", "User not found.");

      const saved = await server.repos.userNotes.setNickname(user.id, id, body.nickname);
      if (!saved) {
        throw new ApiError(400, "VALIDATION_ERROR", "You cannot nickname yourself.");
      }
      await publishNickname(mutationBus, user.id, id, saved.nickname);
      return { nickname: saved.nickname };
    },
  );

  // --- Every private nickname I have set ------------------------------------
  //
  // The client fetches this once and resolves names locally (personal → server →
  // displayName). That is why no other endpoint joins `user_nicknames`: keeping
  // resolution client-side means a private label never has to travel attached to
  // a roster or a message page, where it could be fanned out to the wrong person.
  server.get(
    "/users/me/nicknames",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(LIST_LIMIT) },
    },
    async (request) => {
      const user = requireUser(request);
      return { nicknames: await server.repos.userNotes.listNicknames(user.id) };
    },
  );
}

/**
 * Tell the VIEWER's other devices their private nickname changed. USER-scoped to
 * the viewer, never the target — the person renamed is not told, which is the
 * whole point of a private nickname. Best-effort: the row is the source of truth.
 */
async function publishNickname(
  bus: RealtimeMutationPublisher | undefined,
  viewerId: string,
  targetId: string,
  nickname: string | null,
): Promise<void> {
  await bus?.publish({
    userId: viewerId,
    event: serverEvent.userNicknameUpdated({ targetId, nickname }),
  });
}
