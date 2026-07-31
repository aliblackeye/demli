import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { USERNAME_MAX_LENGTH } from "@demli/config";
import {
  generateSessionToken,
  hashSessionToken,
  sessionExpiresAt,
  type Repositories,
} from "@demli/db";
import { displayNameField } from "@demli/protocol";
import type { PresencePlatform } from "@demli/types";
import { ApiError, parseWith } from "../../errors.js";
import { hashPassword, verifyPassword } from "../../lib/passwords.js";
import { LoginRateLimiter } from "../../lib/login-rate-limiter.js";
import {
  GoogleAuthError,
  resolveGoogleUser,
  type GoogleTokenVerifier,
} from "../../lib/google-auth.js";
import { createGoogleTokenVerifier } from "../../lib/google-verifier.js";
import { requireSessionTokenHash, requireUser } from "../../plugins/auth.js";
import { userRateLimit } from "../../lib/rate-limit.js";

/**
 * Optional device metadata (M15-A) a client may declare when it authenticates,
 * surfaced later in the "active sessions" list. BACK-COMPAT + non-breaking:
 * both are lenient — an omitted, blank, over-long, or unrecognized value never
 * fails auth. `deviceName` is trimmed and capped (a client-facing label, not a
 * security field); `platform` silently coerces anything but the two known
 * surfaces to undefined (→ null) so an odd/newer client cannot 400 its own login.
 */
const deviceNameSchema = z
  .string()
  .optional()
  .transform((value) => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim().slice(0, 120);
    return trimmed.length > 0 ? trimmed : undefined;
  });

const platformSchema = z
  .string()
  .optional()
  .transform((value): PresencePlatform | undefined =>
    value === "desktop" || value === "mobile" ? value : undefined,
  );

const usernameSchema = z
  .string()
  .min(3, "Username must be at least 3 characters.")
  .max(USERNAME_MAX_LENGTH)
  .regex(/^[a-zA-Z0-9_]+$/, "Use letters, numbers and underscores only.")
  .transform((value) => value.toLowerCase());

const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .max(128);

/**
 * Optional date of birth (M15) as an ISO `YYYY-MM-DD` string. Validated to be a
 * real calendar date, with year > 1900 and not in the future ("1900 < year <
 * today"). Stored as-is; the derived `isAdult` gate is computed server-side and
 * the raw value is me-only (never leaked to other users).
 */
export const birthdateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Birthdate must be a date in YYYY-MM-DD form.")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    if (year === undefined || month === undefined || day === undefined) return false;
    if (year <= 1900) return false;
    // Reject an impossible calendar date (round-trips through UTC).
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return false;
    }
    // Not in the future.
    return date.getTime() <= Date.now();
  }, "Enter a valid date of birth.")
  .optional();

const registerBodySchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  // `displayNameField`, not `z.string().trim()`: this is the very first write of
  // the string that will be drawn in every member list, message row, mention and
  // push notification this account ever appears in. Sanitizing it at REGISTER is
  // what stops an RTL-override or all-invisible name from existing at all, rather
  // than being caught later on the one edit path that happens to check.
  displayName: displayNameField.optional(),
  birthdate: birthdateSchema,
  deviceName: deviceNameSchema,
  platform: platformSchema,
});

const loginBodySchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(128),
  /**
   * M15: when the account is FROZEN (soft-deleted) and still within the 14-day
   * window, a plain login is refused with ACCOUNT_FROZEN. Re-sending the same
   * credentials with `reactivate: true` clears the deletion and signs the user in
   * — the account is restored. Ignored for a live account.
   */
  reactivate: z.boolean().optional(),
  deviceName: deviceNameSchema,
  platform: platformSchema,
});

const googleBodySchema = z.object({
  idToken: z.string().min(1, "A Google ID token is required."),
  deviceName: deviceNameSchema,
  platform: platformSchema,
});

export interface AuthModuleOptions {
  /**
   * Google ID-token verifier (0010). Tests inject a mock; production omits it,
   * and one is built from `GOOGLE_CLIENT_ID` when that env is set. When neither
   * is present, `POST /auth/google` answers 501 GOOGLE_AUTH_DISABLED.
   */
  googleVerifier?: GoogleTokenVerifier;
}

/** Optional session metadata (M15-A) recorded at issue time for the sessions list. */
interface SessionMetadata {
  deviceName?: string | undefined;
  platform?: PresencePlatform | undefined;
}

async function issueSession(
  repos: Repositories,
  userId: string,
  ttlHours: number,
  metadata: SessionMetadata = {},
): Promise<string> {
  const token = generateSessionToken();
  await repos.sessions.create({
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt: sessionExpiresAt(new Date(), ttlHours),
    deviceName: metadata.deviceName ?? null,
    platform: metadata.platform ?? null,
  });
  return token;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23505"
  );
}

export async function registerAuthModule(
  server: FastifyInstance,
  options: AuthModuleOptions = {},
): Promise<void> {
  // Second rate-limit dimension keyed on the username, complementing the
  // per-IP @fastify/rate-limit below (security-review H1): stops one account
  // being brute-forced from many IPs / a shared proxy IP.
  const loginLimiter = new LoginRateLimiter();

  // Google sign-in (0010): use the injected verifier (tests) or build one from
  // the configured audiences. `null` ⇒ feature off; the route still registers
  // and answers GOOGLE_AUTH_DISABLED so boot is never affected.
  const googleVerifier: GoogleTokenVerifier | null =
    options.googleVerifier ??
    (server.apiEnv.googleClientIds.length > 0
      ? createGoogleTokenVerifier(server.apiEnv.googleClientIds)
      : null);

  server.post(
    "/auth/register",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const body = parseWith(registerBodySchema, request.body);

      const existing = await server.repos.users.findByUsername(body.username);
      if (existing) {
        throw new ApiError(409, "CONFLICT", "That username is already taken.");
      }

      let user;
      try {
        user = await server.repos.users.create({
          username: body.username,
          displayName: body.displayName ?? body.username,
          passwordHash: await hashPassword(body.password),
          birthdate: body.birthdate ?? null,
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ApiError(409, "CONFLICT", "That username is already taken.");
        }
        throw err;
      }

      const token = await issueSession(server.repos, user.id, server.apiEnv.sessionTtlHours, {
        deviceName: body.deviceName,
        platform: body.platform,
      });
      return reply.status(201).send({ token, user });
    },
  );

  server.post(
    "/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } },
    async (request) => {
      const body = parseWith(loginBodySchema, request.body);

      // Per-username throttle (checked before the argon2 verify so it also
      // caps CPU under a distributed attack on one account).
      if (loginLimiter.isLimited(body.username)) {
        throw new ApiError(
          429,
          "RATE_LIMITED",
          "Too many failed sign-in attempts for this account. Please wait and try again.",
        );
      }

      const record = await server.repos.users.findByUsername(body.username);
      // passwordHash is null for a Google-only account (0010) — never pass it to
      // argon2. Such an account simply has no password path; the generic 401
      // below does not disclose that the username exists.
      const valid =
        record && record.passwordHash
          ? await verifyPassword(record.passwordHash, body.password)
          : false;
      if (!record || !valid) {
        loginLimiter.recordFailure(body.username);
        throw new ApiError(401, "UNAUTHORIZED", "Invalid username or password.");
      }

      loginLimiter.clear(body.username);

      // M15 frozen-account gate. A soft-deleted account within its 14-day window
      // is recoverable: a plain login is refused with ACCOUNT_FROZEN (carrying the
      // purge deadline so the client can offer "Reactivate"), and re-sending with
      // `reactivate: true` clears the deletion and signs the user in. Past the
      // window (row not yet purged) the account is treated as gone — the generic
      // 401 discloses nothing.
      if (record.deletedAt) {
        const withinWindow =
          record.purgeAt !== null && new Date(record.purgeAt).getTime() > Date.now();
        if (!withinWindow) {
          throw new ApiError(401, "UNAUTHORIZED", "Invalid username or password.");
        }
        if (!body.reactivate) {
          throw new ApiError(
            403,
            "ACCOUNT_FROZEN",
            "This account is scheduled for deletion. Reactivate it to sign in.",
            undefined,
            { purgeAt: record.purgeAt },
          );
        }
        await server.repos.users.reactivate(record.id);
      }

      const token = await issueSession(server.repos, record.id, server.apiEnv.sessionTtlHours, {
        deviceName: body.deviceName,
        platform: body.platform,
      });
      const {
        passwordHash: _passwordHash,
        deletedAt: _deletedAt,
        purgeAt: _purgeAt,
        ...user
      } = record;
      return { token, user };
    },
  );

  // "Sign in with Google" (0010). Public, no auth. Verifies the client's Google
  // ID token, find-or-creates/links the account, and issues a session — the
  // response body is IDENTICAL to /auth/login (`{ token, user }`, user via the
  // same `toUser` projection: no passwordHash, no friendCode, no email). New
  // accounts return 201 (like /auth/register); existing ones 200 (like /login).
  // Rate-limited per IP like /auth/login.
  server.post(
    "/auth/google",
    { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      if (!googleVerifier) {
        throw new ApiError(
          501,
          "GOOGLE_AUTH_DISABLED",
          "Google sign-in is not configured on this server.",
        );
      }

      const body = parseWith(googleBodySchema, request.body);

      let claims;
      try {
        claims = await googleVerifier.verifyIdToken(body.idToken);
      } catch {
        // Signature/expiry/audience failure — never leak the SDK's raw reason.
        throw new ApiError(
          401,
          "UNAUTHORIZED",
          "Could not verify your Google sign-in. Please try again.",
        );
      }

      let result;
      try {
        result = await resolveGoogleUser({ store: server.repos.users, claims });
      } catch (err) {
        if (err instanceof GoogleAuthError) {
          // Unverified/absent Google email: refuse to link or create (§28).
          throw new ApiError(403, "FORBIDDEN", err.message);
        }
        throw err;
      }

      const token = await issueSession(
        server.repos,
        result.user.id,
        server.apiEnv.sessionTtlHours,
        { deviceName: body.deviceName, platform: body.platform },
      );
      return reply.status(result.created ? 201 : 200).send({ token, user: result.user });
    },
  );

  server.post(
    "/auth/logout",
    {
      preHandler: [server.authenticate],
      config: {
        // A session logs out once; 20/min is unreachable for a real client and
        // stops a stolen token from being used to hammer session deletes.
        rateLimit: userRateLimit({ max: 20, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      await server.repos.sessions.deleteByTokenHash(requireSessionTokenHash(request));
      return reply.status(204).send();
    },
  );

  // Sign out everywhere: revoke every session for the user (security-review M2).
  // The current token is included, so the caller is logged out too. Intended for
  // "log out all devices" and for suspected-compromise recovery; a future
  // password-change endpoint should call sessions.deleteAllForUser as well
  // (see .claude/reports/f-security-hardening-1.md — password change is a
  // follow-up, no such endpoint exists yet).
  server.post(
    "/auth/logout-all",
    {
      preHandler: [server.authenticate],
      config: {
        // Tighter than plain logout: this one deletes EVERY row for the user, so
        // it is the heaviest write an ordinary session can trigger. A human uses
        // it once, maybe twice; 10/min is pure abuse headroom.
        rateLimit: userRateLimit({ max: 10, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      await server.repos.sessions.deleteAllForUser(user.id);
      return reply.status(204).send();
    },
  );
}
