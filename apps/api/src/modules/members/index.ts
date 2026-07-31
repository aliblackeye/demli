/**
 * Per-server member nicknames (migration 0020, ADR 0019 §3).
 *
 * Route:
 *   PUT /groups/:groupId/members/:userId/nickname   { nickname: string | null }
 *
 * This is the PUBLIC nickname — everyone in the server sees it in the roster, on
 * message rows and in the voice panel. It is not the private per-viewer nickname
 * (`modules/user-notes`), and the two are stored in different places on purpose:
 * merging them would turn one person's private label into a whole server's
 * public one.
 *
 * **Authority.** Two different rules in one route, which is why the permission
 * check is inside a branch rather than at the top:
 *
 *   - Your OWN nickname: every member may set it, no permission bit. That is the
 *     right default for a friend-group app — picking what a server calls you is
 *     self-expression, not moderation.
 *   - SOMEONE ELSE'S: owner ∨ `MANAGE_NICKNAMES`, plus the standard owner
 *     immunity (nobody renames the owner but the owner).
 *
 * `MANAGE_NICKNAMES` is a NEW bit (1 << 5) rather than a reuse of an existing
 * one. Reusing `KICK_MEMBERS` — the only other member-scoped bit — would mean an
 * owner had to grant the power to REMOVE people in order to delegate the power to
 * fix a nickname. A cosmetic, fully reversible action must not require a
 * destructive permission; that inversion is exactly what a bitfield exists to
 * prevent. It is one more entry in the existing `PERMISSIONS` record, not a new
 * mechanism: `ALL_PERMISSIONS` picks it up automatically and the roles module's
 * "unknown bit" refine already covers it.
 *
 * Realtime: `member.nickname_updated`, GROUP-scoped — the same audience and
 * routing as `member.roles_updated`, because a public name change has to reach
 * every connected member's cached roster without a reconnect.
 */

import type { FastifyInstance } from "fastify";
import type { RealtimeMutationPublisher } from "@demli/db";
import { memberParamsSchema, serverEvent, setMemberNicknameBodySchema } from "@demli/protocol";
import { PERMISSIONS } from "@demli/types";
import { ApiError, parseWith } from "../../errors.js";
import { loadServer, requirePerm } from "../../lib/permissions.js";
import { requireUser } from "../../plugins/auth.js";
import { userRateLimit } from "../../lib/rate-limit.js";

export async function registerMembersModule(
  server: FastifyInstance,
  mutationBus?: RealtimeMutationPublisher,
): Promise<void> {
  server.put(
    "/groups/:groupId/members/:userId/nickname",
    {
      preHandler: [server.authenticate],
      config: {
        // A nickname change fans out to the whole server, so it is a broadcast
        // trigger as much as a write. 30/min is unreachable in real use and
        // stops one session from driving a roster-refresh storm — the same
        // reasoning and the same number as the role mutations.
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const actor = requireUser(request);
      const { groupId, userId } = parseWith(memberParamsSchema, request.params);
      const body = parseWith(setMemberNicknameBodySchema, request.body);

      // 404 (not 403) for non-members / non-servers — membership and kind are
      // never leaked, exactly like every other group-scoped route.
      const { group, role } = await loadServer(server, groupId, actor.id);

      if (userId !== actor.id) {
        // The owner's nickname is theirs alone. Mirrors the kick/ban owner
        // immunity: a moderator who could rename the owner could impersonate
        // them in every message row in the server.
        if (userId === group.ownerId) {
          throw new ApiError(
            403,
            "FORBIDDEN",
            "You cannot change the server owner's nickname.",
          );
        }
        await requirePerm(
          server,
          groupId,
          role,
          actor.id,
          PERMISSIONS.MANAGE_NICKNAMES,
          "You do not have permission to change other members' nicknames.",
        );
      }

      const updated = await server.repos.groups.setMemberNickname(
        groupId,
        userId,
        body.nickname,
      );
      if (!updated) throw new ApiError(404, "NOT_FOUND", "Member not found.");

      // GROUP-scoped: this name is public to the server, so every connected
      // member needs it. Best-effort — the row is already the source of truth.
      await mutationBus?.publish({
        groupId,
        event: serverEvent.memberNicknameUpdated({
          groupId,
          userId,
          nickname: updated.nickname ?? null,
        }),
      });

      return { member: updated };
    },
  );
}
