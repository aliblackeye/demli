import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RealtimeMutationPublisher } from "@demli/db";
import { serverEvent } from "@demli/protocol";
import { requireUser } from "../../plugins/auth.js";
import { ApiError, errorBody, parseWith } from "../../errors.js";
import { userRateLimit } from "../../lib/rate-limit.js";
import { GameCoordinator } from "./game-coordinator.js";

export { GameCoordinator } from "./game-coordinator.js";

const inviteBody = z.object({
  targetUserId: z.string().min(1),
  channelId: z.string().min(1),
  gameType: z.literal("minesweeper-flags"),
});

const gameIdParam = z.object({
  gameId: z.string().uuid(),
});

const moveBody = z.object({
  action: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("reveal"),
      row: z.number().int().min(0).max(15),
      col: z.number().int().min(0).max(15),
    }),
    z.object({
      type: z.literal("bomb"),
      centerRow: z.number().int().min(0).max(15),
      centerCol: z.number().int().min(0).max(15),
    }),
  ]),
});

export function createGameCoordinator(
  mutationBus?: RealtimeMutationPublisher,
): GameCoordinator {
  return new GameCoordinator(mutationBus);
}

export async function registerGamesModule(
  server: FastifyInstance,
  coordinator: GameCoordinator,
  mutationBus?: RealtimeMutationPublisher,
): Promise<void> {
  server.post(
    "/games/invite",
    { config: { rateLimit: userRateLimit({ max: 10, timeWindow: "1m" }) } },
    async (request, reply) => {
      const user = requireUser(request);
      const body = parseWith(inviteBody, request.body);
      const result = await coordinator.invite(
        user.id,
        body.targetUserId,
        body.channelId,
      );
      if ("error" in result) {
        throw new ApiError(400, "INVALID_PAYLOAD", result.error);
      }
      return reply.code(201).send({ gameId: result.gameId });
    },
  );

  server.post(
    "/games/:gameId/accept",
    { config: { rateLimit: userRateLimit({ max: 10, timeWindow: "1m" }) } },
    async (request, reply) => {
      const user = requireUser(request);
      const { gameId } = parseWith(gameIdParam, request.params);
      const result = await coordinator.accept(user.id, gameId);
      if ("error" in result) {
        throw new ApiError(400, "INVALID_PAYLOAD", result.error);
      }
      // Best-effort system message in the channel
      try {
        const msg = await server.repos.messages.create({
          channelId: result.channelId,
          authorId: result.inviterUserId,
          content: "@sys:game_started",
          kind: "system",
        });
        await mutationBus?.publish({
          channelId: result.channelId,
          event: serverEvent.messageCreated(msg),
        });
      } catch (err) {
        server.log.error({ err }, "game system message write failed");
      }
      return reply.code(200).send({ ok: true });
    },
  );

  server.post(
    "/games/:gameId/decline",
    { config: { rateLimit: userRateLimit({ max: 10, timeWindow: "1m" }) } },
    async (request, reply) => {
      const user = requireUser(request);
      const { gameId } = parseWith(gameIdParam, request.params);
      const result = await coordinator.decline(user.id, gameId);
      if ("error" in result) {
        throw new ApiError(400, "INVALID_PAYLOAD", result.error);
      }
      return reply.code(200).send({ ok: true });
    },
  );

  server.post(
    "/games/:gameId/move",
    { config: { rateLimit: userRateLimit({ max: 120, timeWindow: "1m" }) } },
    async (request, reply) => {
      const user = requireUser(request);
      const { gameId } = parseWith(gameIdParam, request.params);
      const body = parseWith(moveBody, request.body);
      const result = await coordinator.move(user.id, gameId, body.action);
      if ("error" in result) {
        throw new ApiError(400, "INVALID_PAYLOAD", result.error);
      }
      // Game finished → system message with final score
      if (result.finished) {
        try {
          const { channelId, scores } = result.finished;
          const msg = await server.repos.messages.create({
            channelId,
            authorId: user.id,
            content: `@sys:game_ended:${scores[1]}-${scores[2]}`,
            kind: "system",
          });
          await mutationBus?.publish({
            channelId,
            event: serverEvent.messageCreated(msg),
          });
        } catch (err) {
          server.log.error({ err }, "game system message write failed");
        }
      }
      return reply.code(200).send({ ok: true });
    },
  );
}
