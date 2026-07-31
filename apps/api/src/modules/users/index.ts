import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { RealtimeMutationPublisher } from "@demli/db";
import {
  bioField,
  customStatusField,
  displayNameField,
  mediaUrlField,
  serverEvent,
} from "@demli/protocol";
import { ApiError, parseWith } from "../../errors.js";
import { requireUser } from "../../plugins/auth.js";
import { ownedObjectPath, type AvatarStorage } from "../../lib/storage.js";
import type { MediaModerator } from "../../lib/media-moderation.js";
import { buildAvatarStoragePath, decodeAvatarUpload } from "../../lib/avatar-upload.js";
import { buildBannerStoragePath, decodeBannerUpload } from "../../lib/banner-upload.js";
import { birthdateSchema } from "../auth/index.js";
import { READ_LIMIT, userRateLimit } from "../../lib/rate-limit.js";

/** Longest a custom status may be scheduled to live (7 days). */
const CUSTOM_STATUS_MAX_MINUTES = 7 * 24 * 60;

/**
 * Set/clear body. `text: null` OR a blank/whitespace-only string CLEARS the
 * status (and its expiry with it) — "empty means clear" is the founder-stated
 * rule, so a client does not need a separate delete call for the common case
 * (the DELETE route exists anyway for an explicit clear).
 *
 * `customStatusField` (not a bare `z.string().max(...)`) so the value is
 * SANITIZED: a status is drawn on the member list and in the profile card, and
 * a raw one could carry U+202E and flip the rest of that line right-to-left, or
 * be made entirely of zero-width characters and render as a blank line the user
 * cannot explain. Neither is XSS — the sinks escape — but both let one account
 * decide how another account's row looks, which is not a decision a client gets
 * to make. The cap is the same 128; the field just also strips what nobody can
 * see. Markdown, emoji and punctuation are untouched (see `sanitizeText`).
 */
const setCustomStatusSchema = z.object({
  text: customStatusField.nullable(),
  /** Auto-clear after N minutes ("30 min", "today"); omit for indefinite. */
  expiresInMinutes: z
    .number()
    .int()
    .min(1)
    .max(CUSTOM_STATUS_MAX_MINUTES)
    .optional(),
});

/**
 * Inline avatar upload body: the image (base64) + its declared MIME. The declared
 * MIME is only a hint — the API magic-byte-sniffs the real bytes (§28). Base64
 * inflates the 2 MB cap to ~2.7 MB; the route's `bodyLimit` guards the raw body,
 * and {@link decodeAvatarUpload} re-checks the true decoded size.
 */
const uploadAvatarSchema = z.object({
  mime: z.string().min(1).max(255),
  dataBase64: z.string().min(1),
});

/**
 * Inline banner upload body — identical shape to the avatar body. The declared
 * MIME is a hint only; the API magic-byte-sniffs the real bytes (§28). Banners
 * allow GIF and a larger cap than avatars ({@link ./banner-upload}).
 */
const uploadBannerSchema = z.object({
  mime: z.string().min(1).max(255),
  dataBase64: z.string().min(1),
});

/**
 * `PATCH /users/me`.
 *
 * Every field here comes from `@demli/protocol` rather than being re-declared,
 * and two of those swaps are security fixes, not tidying:
 *
 *  - `mediaUrlField` in place of `z.string().url()`. Zod's `.url()` asks only
 *    whether `new URL()` succeeds, and it succeeds for `javascript:alert(1)`,
 *    `data:text/html,…` and `file:///…`. This value is persisted and then served
 *    to every client that can see the user, so "any parseable URL" made the
 *    avatar an attacker-chosen fetch: on mobile there is no CSP to stop it, and
 *    pointing an avatar at your own host turns "someone opened my friend
 *    request" into a log line with their IP in it. `mediaUrlField` requires an
 *    absolute http(s) URL and nothing else.
 *  - `displayNameField` in place of `z.string().trim()`. A display name is drawn
 *    in the member list, on every message row, in mentions and in push
 *    notifications; unsanitized it can be an RTL override that flips the line it
 *    sits in, or entirely invisible characters that leave a nameless row. The
 *    field strips those and demands one genuinely visible character.
 */
const updateProfileSchema = z
  .object({
    displayName: displayNameField.optional(),
    avatarUrl: mediaUrlField.nullable().optional(),
    bio: bioField.nullable().optional(),
    /** Public banner URL; `null` clears it (the file upload path sets a real URL). */
    bannerUrl: mediaUrlField.nullable().optional(),
    /**
     * Date of birth (M15) as `YYYY-MM-DD`. SET-ONCE: accepted here only while the
     * account has none yet (pre-M15 users + the NSFW age-gate "add your birthdate"
     * flow). New sign-ups set it at register. The immutability guard is in the
     * handler; this only validates the shape (real date, year > 1900, not future).
     */
    birthdate: birthdateSchema,
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update.",
  });

const userParamsSchema = z.object({
  id: z.string().uuid("Invalid user id."),
});

/** Optional shared-server context for the profile card's role list (§3). */
const profileQuerySchema = z.object({
  groupId: z.string().uuid("Invalid group id.").optional(),
});

export interface UsersModuleDeps {
  /** Public avatar/banner bucket wrapper, or null when uploads are disabled (feature off). */
  avatarStorage: AvatarStorage | null;
  /** Server-side NSFW seam (no-op `skipped` fail-open until the founder flips MEDIA_MODERATION_MODE). */
  mediaModerator: MediaModerator;
  /**
   * Realtime publisher. Two uses:
   * - account deletion kicks the user's live sockets via `session.revoked` (M15);
   * - every public-profile mutation announces `user.updated` to everyone who can
   *   see the user, so their avatar/name repaints live ({@link publishProfileUpdate}).
   *
   * Optional — omitted in tests that do not assert the fan-out; the writes still
   * land in the DB either way (the publish is best-effort, never load-bearing).
   */
  mutationBus?: RealtimeMutationPublisher;
}

export async function registerUsersModule(
  server: FastifyInstance,
  deps: UsersModuleDeps,
): Promise<void> {
  const { avatarStorage, mediaModerator, mutationBus } = deps;

  /**
   * Announce a public profile change to everyone who can see this user.
   *
   * Publishes ONE user-scoped mutation; the gateway expands it to the presence
   * audience (co-members of any shared group ∪ accepted friends ∪ the user's own
   * other sessions) — the API never enumerates recipients itself, so the
   * "who can see me" rule lives in exactly one place (`presenceAudience`).
   *
   * `user` MUST be the PUBLIC projection (`updateProfile` / `findById`), never the
   * `findSelf` row: the self row carries `friendCode`/`birthdate`/`isAdult`.
   * `userSchema` strips those at the codec anyway (defence in depth), but passing
   * the public shape keeps the intent obvious at the call site.
   *
   * Best-effort by design: the row is ALREADY committed when this runs, so a bus
   * failure must not turn a successful save into an error response. It is logged
   * and swallowed; the stale viewer heals on their next refetch.
   */
  async function publishProfileUpdate(
    request: FastifyRequest,
    user: Awaited<ReturnType<typeof server.repos.users.findById>>,
  ): Promise<void> {
    if (!mutationBus || !user) return;
    try {
      await mutationBus.publish({
        userId: user.id,
        event: serverEvent.userUpdated({ user }),
      });
    } catch (err) {
      request.log.error({ err, userId: user.id }, "user.updated publish failed");
    }
  }

  // `/users/me` uses `findSelf`, the ONLY read that includes the private
  // `friendCode` (ADR 0010 §2). Every other-user read below uses `findById` /
  // `getProfile`, which strip it — the code never leaks off the self surface.
  server.get(
    "/users/me",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(READ_LIMIT) },
    },
    async (request) => {
      const user = requireUser(request);
      const self = await server.repos.users.findSelf(user.id);
      if (!self) throw new ApiError(404, "NOT_FOUND", "User not found.");
      return { user: self };
    },
  );

  server.patch(
    "/users/me",
    {
      preHandler: [server.authenticate],
      config: {
        // A profile write broadcasts `user.updated` to everyone who shares a
        // group or friendship with this user, so the fan-out — not the row
        // write — is the lever. 30/min matches the other profile-adjacent
        // writes in this module and is far above any real editing session.
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const body = parseWith(updateProfileSchema, request.body);
      // Birthdate is SET-ONCE (age-gate integrity, M15): writable only while still
      // null, never changeable afterwards — otherwise a minor could flip the NSFW
      // age gate at will. New sign-ups set it at /auth/register; pre-M15 accounts
      // set it here exactly once (the NSFW gate's "add your birthdate" button).
      if (body.birthdate !== undefined) {
        const current = await server.repos.users.findSelf(user.id);
        if (current?.birthdate) {
          throw new ApiError(
            409,
            "BIRTHDATE_LOCKED",
            "Your date of birth is already set and can't be changed.",
          );
        }
      }
      const updated = await server.repos.users.updateProfile(user.id, body);
      if (!updated) throw new ApiError(404, "NOT_FOUND", "User not found.");
      // Tell everyone who can see this user that the profile changed — `updated` is
      // the PUBLIC shape, which is exactly what the event must carry.
      await publishProfileUpdate(request, updated);
      // Re-project as self so the response keeps `friendCode` (updateProfile
      // returns the public shape); the caller's own view stays consistent with GET.
      const self = await server.repos.users.findSelf(user.id);
      return { user: self ?? updated };
    },
  );

  // Upload a profile photo (link → file). The image rides inline (base64), so the
  // API holds the REAL bytes and validates them (whitelist → size → magic bytes)
  // BEFORE storing anything — same posture as the custom-emoji path. The bucket
  // is PUBLIC, so the resulting stable URL is persisted straight onto the user
  // row via `updateProfile` and served without a signed read.
  //
  // OFF BY DEFAULT: with SUPABASE_AVATAR_BUCKET unset `avatarStorage` is null and
  // this answers 503 AVATAR_UPLOADS_DISABLED, so production is unchanged until the
  // founder creates a public bucket and sets that one env line.
  server.post(
    "/users/me/avatar",
    {
      preHandler: [server.authenticate],
      // Heavier than a normal mutation (writes bytes + runs the moderation seam).
      // Per-session burst guard, not the real limit — the 2 MB cap bounds each write.
      config: {
        rateLimit: userRateLimit({ max: 12, timeWindow: "1 minute" }),
      },
      // Base64 inflates the 2 MB cap to ~2.7 MB; 4 MB leaves room for the JSON
      // envelope while rejecting a hostile body before it is parsed (the decoder
      // re-checks the true decoded size anyway).
      bodyLimit: 4 * 1024 * 1024,
    },
    async (request) => {
      if (!avatarStorage) {
        throw new ApiError(
          503,
          "AVATAR_UPLOADS_DISABLED",
          "Avatar uploads are not available on this server.",
        );
      }
      const user = requireUser(request);
      const body = parseWith(uploadAvatarSchema, request.body);

      // Validate the REAL bytes before anything is stored or screened.
      const { bytes, mime } = decodeAvatarUpload(body);

      // Server-side NSFW seam — BEFORE store, so it cannot be bypassed. A profile
      // is ALWAYS screened (never NSFW). Fail-open: `skipped` (moderation off / a
      // module error) proceeds; only an explicit reject blocks. The reason is
      // logged, never surfaced verbatim to the client.
      const moderation = await mediaModerator.check({ bytes, mime, subject: "avatar" });
      if (moderation.verdict === "rejected") {
        request.log.info({ userId: user.id, reason: moderation.reason }, "avatar rejected by moderation");
        throw new ApiError(422, "AVATAR_REJECTED", "That image can't be used as an avatar.");
      }
      if (moderation.verdict === "skipped" && moderation.error) {
        request.log.warn({ err: moderation.error }, "avatar moderation failed open");
      }

      const storagePath = buildAvatarStoragePath(user.id, mime);
      await avatarStorage.upload(storagePath, bytes, mime);
      const publicUrl = avatarStorage.publicUrl(storagePath);

      // Remember the old object so we can purge it after the row points at the new
      // one (best-effort — a stray public object is cost, not a correctness bug).
      const previous = await server.repos.users.findById(user.id);
      const previousAvatarUrl = previous?.avatarUrl ?? null;

      const updated = await server.repos.users.updateProfile(user.id, { avatarUrl: publicUrl });
      if (!updated) {
        // The user vanished mid-request — purge the just-uploaded orphan and 404.
        try {
          await avatarStorage.remove([storagePath]);
        } catch (err) {
          request.log.error({ err, storagePath }, "avatar upload: orphan purge failed");
        }
        throw new ApiError(404, "NOT_FOUND", "User not found.");
      }

      // Purge the previous avatar object IF it was one of OURS (a public URL in
      // this bucket). A Google/external avatar URL has no object key here, so it
      // is left untouched. Best-effort.
      const previousPath = ownedObjectPath(previousAvatarUrl, avatarStorage);
      if (previousPath && previousPath !== storagePath) {
        try {
          await avatarStorage.remove([previousPath]);
        } catch (err) {
          request.log.error({ err, previousPath }, "avatar upload: old-object purge failed");
        }
      }

      // The founder's exact complaint: a new photo must reach other people's
      // member sidebars without a reload.
      await publishProfileUpdate(request, updated);

      const self = await server.repos.users.findSelf(user.id);
      return { user: self ?? updated };
    },
  );

  // Upload a profile BANNER (M15). Same posture as the avatar path — inline
  // base64, real bytes validated (whitelist → cap → magic bytes) BEFORE storage
  // — but banners allow GIF and a larger cap (5 MB). Reuses the SAME public
  // avatar bucket + gate, stored under `banners/<userId>/…`; with the bucket
  // unset this answers 503 BANNER_UPLOADS_DISABLED (prod unchanged until the
  // founder turns avatar/banner uploads on). A profile is ALWAYS NSFW-screened
  // (fail-open when moderation is off).
  server.post(
    "/users/me/banner",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 12, timeWindow: "1 minute" }),
      },
      // Base64 inflates the 5 MB cap to ~6.7 MB; 8 MB leaves room for the JSON
      // envelope while rejecting a hostile body before it is parsed.
      bodyLimit: 8 * 1024 * 1024,
    },
    async (request) => {
      if (!avatarStorage) {
        throw new ApiError(
          503,
          "BANNER_UPLOADS_DISABLED",
          "Banner uploads are not available on this server.",
        );
      }
      const user = requireUser(request);
      const body = parseWith(uploadBannerSchema, request.body);

      const { bytes, mime } = decodeBannerUpload(body);

      const moderation = await mediaModerator.check({ bytes, mime, subject: "banner" });
      if (moderation.verdict === "rejected") {
        request.log.info({ userId: user.id, reason: moderation.reason }, "banner rejected by moderation");
        throw new ApiError(422, "BANNER_REJECTED", "That image can't be used as a banner.");
      }
      if (moderation.verdict === "skipped" && moderation.error) {
        request.log.warn({ err: moderation.error }, "banner moderation failed open");
      }

      const storagePath = buildBannerStoragePath(user.id, mime);
      await avatarStorage.upload(storagePath, bytes, mime);
      const publicUrl = avatarStorage.publicUrl(storagePath);

      const previous = await server.repos.users.findById(user.id);
      const previousBannerUrl = previous?.bannerUrl ?? null;

      const updated = await server.repos.users.updateProfile(user.id, { bannerUrl: publicUrl });
      if (!updated) {
        try {
          await avatarStorage.remove([storagePath]);
        } catch (err) {
          request.log.error({ err, storagePath }, "banner upload: orphan purge failed");
        }
        throw new ApiError(404, "NOT_FOUND", "User not found.");
      }

      const previousPath = ownedObjectPath(previousBannerUrl, avatarStorage);
      if (previousPath && previousPath !== storagePath) {
        try {
          await avatarStorage.remove([previousPath]);
        } catch (err) {
          request.log.error({ err, previousPath }, "banner upload: old-object purge failed");
        }
      }

      await publishProfileUpdate(request, updated);

      const self = await server.repos.users.findSelf(user.id);
      return { user: self ?? updated };
    },
  );

  // Delete (FREEZE) my account (M15). Soft-delete: stamps `deleted_at`/`purge_at`
  // (now + 14 days) and revokes EVERY session, so the account immediately
  // disappears from member/search reads and cannot authenticate. Recoverable by
  // signing in within the window with `{ reactivate: true }`. The hourly purge job
  // anonymizes it after the deadline. Rate-limited (a session-scoped burst guard).
  server.post(
    "/users/me/delete",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 5, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      // Snapshot live session ids BEFORE revoking so we can kick those sockets.
      const live = await server.repos.sessions.listForUser(user.id);
      const result = await server.repos.users.softDelete(user.id);
      if (!result) throw new ApiError(404, "NOT_FOUND", "User not found.");
      await server.repos.sessions.deleteAllForUser(user.id);
      // Kick every live connection (this user's own devices) so they log out now.
      if (mutationBus && live.length > 0) {
        await mutationBus.publish({
          userId: user.id,
          event: serverEvent.sessionRevoked({ sessionIds: live.map((s) => s.id) }),
        });
      }
      return { deletedAt: result.deletedAt, purgeAt: result.purgeAt };
    },
  );

  // Set or clear my custom status (M18). `text: null` or a blank string clears
  // it — and clears the expiry with it, since an expiry without a status is
  // meaningless. The value is stored RAW (plain text) and escaped at render time
  // like message content (§28), so nothing the user typed is silently mangled.
  //
  // Realtime: a USER-scoped `user.custom_status_updated`. The gateway forwards it
  // to my own devices AND re-broadcasts my presence to the audience (co-members ∪
  // accepted friends), so peers pick the new line up through the
  // `presence.updated` they already handle — no new routing, no new audience.
  server.put(
    "/users/me/custom-status",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 20, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const body = parseWith(setCustomStatusSchema, request.body);

      const trimmed = body.text === null ? null : body.text.trim();
      const clearing = trimmed === null || trimmed.length === 0;
      const expiresAt =
        clearing || body.expiresInMinutes === undefined
          ? null
          : new Date(Date.now() + body.expiresInMinutes * 60 * 1000);

      const updated = await server.repos.users.setCustomStatus(user.id, {
        text: clearing ? null : trimmed,
        expiresAt,
      });
      if (!updated) throw new ApiError(404, "NOT_FOUND", "User not found.");

      await mutationBus?.publish({
        userId: user.id,
        event: serverEvent.customStatusUpdated({
          userId: user.id,
          // Echo the PERSISTED values (the mapper already applied the expiry), so
          // the event can never disagree with what a later fetch returns.
          text: updated.customStatus ?? null,
          expiresAt: updated.customStatusExpiresAt ?? null,
        }),
      });

      const self = await server.repos.users.findSelf(user.id);
      return { user: self ?? updated };
    },
  );

  // Explicit clear — the same primitive as `PUT` with a null text. Kept as its
  // own verb so a "Clear status" button is one obvious call.
  server.delete(
    "/users/me/custom-status",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 20, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const updated = await server.repos.users.setCustomStatus(user.id, {
        text: null,
        expiresAt: null,
      });
      if (!updated) throw new ApiError(404, "NOT_FOUND", "User not found.");

      await mutationBus?.publish({
        userId: user.id,
        event: serverEvent.customStatusUpdated({
          userId: user.id,
          text: null,
          expiresAt: null,
        }),
      });

      const self = await server.repos.users.findSelf(user.id);
      return { user: self ?? updated };
    },
  );

  // Mint a fresh friend code, invalidating the old one (ADR 0010 §2).
  // Rate-limited so a code cannot be churned abusively.
  //
  // @deprecated (#111) Friend codes are being removed in favour of
  // add-by-username. Current clients no longer surface a "regenerate code" UI;
  // this route is kept ONLY so pre-#111 clients keep working for a release or
  // two. Behaviour is unchanged — do NOT delete until those clients age out.
  server.post(
    "/users/me/friend-code/regenerate",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 5, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const self = await server.repos.users.regenerateFriendCode(user.id);
      if (!self) throw new ApiError(404, "NOT_FOUND", "User not found.");
      return { user: self };
    },
  );

  // Minimal public profile. `toUser` already omits the password hash AND the
  // friend code, so the shape is the safe public `User` DTO. Authenticated
  // (static `/users/me` wins the route match, so `:id` never captures "me").
  server.get(
    "/users/:id",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(READ_LIMIT) },
    },
    async (request) => {
      const { id } = parseWith(userParamsSchema, request.params);
      const user = await server.repos.users.findById(id);
      if (!user) throw new ApiError(404, "NOT_FOUND", "User not found.");
      return { user };
    },
  );

  // Context-aware profile card (ADR 0010 §3): the target user + the viewer→
  // target friendship + (only when `groupId` names a server BOTH belong to)
  // the target's roles there. The repo gates role visibility, so a stranger's
  // card or a server the viewer is not in never leaks roles. `friendCode` is
  // never present (getProfile projects via `toUser`).
  server.get(
    "/users/:id/profile",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(READ_LIMIT) },
    },
    async (request) => {
      const viewer = requireUser(request);
      const { id } = parseWith(userParamsSchema, request.params);
      const { groupId } = parseWith(profileQuerySchema, request.query);
      const profile = await server.repos.users.getProfile(viewer.id, id, groupId);
      if (!profile) throw new ApiError(404, "NOT_FOUND", "User not found.");
      return { profile };
    },
  );
}
