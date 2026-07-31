import { Expo } from "expo-server-sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseWith } from "../../errors.js";
import { requireUser } from "../../plugins/auth.js";
import { userRateLimit } from "../../lib/rate-limit.js";

/**
 * Device-token endpoints (task #46 — mobile push registration).
 *
 * The mobile client obtains an Expo push token from the OS and registers it
 * here; the server persists it (`device_tokens`, upsert on the token) so it can
 * push message / friend-request notifications when the user is offline. On
 * logout — or when the client learns its token is stale — it unregisters.
 *
 * No realtime event is involved (registration is private to the caller); there
 * is nothing to fan out. Both routes are session-authenticated and rate-limited
 * (§28). Token FORMAT is validated with `Expo.isExpoPushToken`, so a garbage
 * value never reaches the push path.
 */

/** Expo push token — "ExponentPushToken[…]" / "ExpoPushToken[…]". */
const pushTokenSchema = z
  .string()
  .trim()
  .min(1, "Push token is required.")
  .max(256)
  .refine((value) => Expo.isExpoPushToken(value), {
    message: "Not a valid Expo push token.",
  });

const registerTokenSchema = z.object({
  token: pushTokenSchema,
  platform: z.enum(["ios", "android"]),
});

const unregisterTokenSchema = z.object({
  token: pushTokenSchema,
});

export async function registerDevicesModule(server: FastifyInstance): Promise<void> {
  // Register (or re-register) the caller's push token. Idempotent: the repo
  // upserts on the token, re-binding the device to the caller and bumping
  // last_seen_at. Rate-limited to curb token-spam.
  server.post(
    "/devices/token",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 10, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { token, platform } = parseWith(registerTokenSchema, request.body);
      await server.repos.deviceTokens.upsert(user.id, token, platform);
      return { registered: true };
    },
  );

  // Unregister a token the caller owns (logout / stale token). Scoped to the
  // caller so one user cannot delete another's registration. Idempotent — a
  // missing/foreign token is still a 204 (nothing to reveal, §28).
  server.delete(
    "/devices/token",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 10, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { token } = parseWith(unregisterTokenSchema, request.body);
      await server.repos.deviceTokens.deleteForUser(user.id, token);
      return reply.status(204).send();
    },
  );
}
