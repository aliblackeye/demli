import type { z } from "zod";

/**
 * Typed, user-friendly API errors (CLAUDE.md §26). Handlers throw ApiError;
 * the central error handler renders `{ error: { code, message } }`.
 * Raw stack traces never reach a client.
 */

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  // #111 / founder directive 2026-07-28: add-by-username answers 404
  // USER_NOT_FOUND when no account holds that username. Distinct from the
  // generic NOT_FOUND on purpose — it is the ONE not-found a user can act on
  // ("check the spelling"), so it earns copy of its own instead of "we couldn't
  // find what you were looking for". See modules/friends for why disclosing it
  // is the right trade now.
  | "USER_NOT_FOUND"
  | "CONFLICT"
  | "INVALID_CHANNEL"
  | "INVALID_ATTACHMENT"
  // ADR 0011: a reply target in another channel / missing (INVALID_PAYLOAD),
  // and an emoji outside the fixed REACTION_EMOJI palette (INVALID_REACTION).
  | "INVALID_PAYLOAD"
  | "INVALID_REACTION"
  | "ATTACHMENTS_DISABLED"
  // M17 pins: the channel already holds PINS_MAX_PER_CHANNEL pinned messages.
  | "PINS_FULL"
  // M17 custom emoji: the upload is not a valid PNG/WebP (declared MIME off the
  // whitelist, or the real magic bytes disagree with it), it exceeds
  // CUSTOM_EMOJI_MAX_BYTES, the group is at CUSTOM_EMOJI_MAX_PER_GROUP, the name
  // is already used in this group, or storage is not configured (feature off).
  | "INVALID_EMOJI"
  | "EMOJI_TOO_LARGE"
  | "EMOJI_LIMIT"
  | "EMOJI_NAME_TAKEN"
  | "EMOJI_DISABLED"
  // Avatar uploads (profile photo). INVALID_AVATAR: declared MIME off the
  // whitelist or the real magic bytes disagree with it. AVATAR_TOO_LARGE: over
  // AVATAR_MAX_BYTES (2 MB). AVATAR_UPLOADS_DISABLED: SUPABASE_AVATAR_BUCKET is
  // unset (feature off). AVATAR_REJECTED: the server-side NSFW seam rejected it.
  | "INVALID_AVATAR"
  | "AVATAR_TOO_LARGE"
  | "AVATAR_UPLOADS_DISABLED"
  | "AVATAR_REJECTED"
  // Profile banner uploads (M15) — mirror the avatar codes. INVALID_BANNER:
  // declared MIME off the whitelist, the real magic bytes disagree, or the image
  // is over the pixel budget (decompression bomb — a few hundred KB on the wire
  // that decodes to gigabytes). BANNER_TOO_LARGE: over BANNER_MAX_BYTES.
  // BANNER_UPLOADS_DISABLED: the avatar bucket is unset (feature off, same gate).
  // BANNER_REJECTED: the NSFW seam rejected it (a profile can never be NSFW).
  | "INVALID_BANNER"
  | "BANNER_TOO_LARGE"
  | "BANNER_UPLOADS_DISABLED"
  | "BANNER_REJECTED"
  // Server banner uploads (M20) — the profile-banner codes applied to a group, so
  // the client can say "server banner" instead of "your banner". Same validation
  // chain and same gate; INVALID_GROUP_BANNER likewise covers the pixel budget.
  | "INVALID_GROUP_BANNER"
  | "GROUP_BANNER_TOO_LARGE"
  | "GROUP_BANNER_UPLOADS_DISABLED"
  | "GROUP_BANNER_REJECTED"
  // Account deletion (M15): signing in to a frozen account within the 14-day
  // window (the client offers reactivation; `details.purgeAt` carries the deadline).
  | "ACCOUNT_FROZEN"
  // Age gate (M15): PATCH /users/me with a birthdate when one is already set.
  // Birthdate is set-once so a minor can't flip the NSFW gate after registering.
  | "BIRTHDATE_LOCKED"
  // Media moderation (M15): an image attachment posted to a NON-NSFW channel that
  // the moderation seam flagged as NSFW. Deliberately lowercase — this exact wire
  // string is the cross-agent contract the clients switch on.
  | "nsfw_content_blocked"
  // 0010: POST /auth/google when GOOGLE_CLIENT_ID is unset (feature off).
  | "GOOGLE_AUTH_DISABLED"
  | "INVITE_EXPIRED"
  | "INVITE_EXHAUSTED"
  // Migration 0017: redeeming an invite for a server you are banned from.
  | "GROUP_BANNED"
  // M18 (ADR 0017): a block exists between the caller and the other user, in
  // EITHER direction. Deliberately ONE code with one message for both directions
  // — which side blocked whom is never disclosed (§28). Raised by DM open/send,
  // friend request, DM call start/accept, group-DM member add, and group-DM
  // invite redemption.
  | "BLOCKED"
  // Migration 0020 (ADR 0019): the caller is TIMED OUT in the relevant server.
  // Raised by message send, reaction add, and the voice-token mint. Distinct from
  // BLOCKED (a relationship between two users) and from FORBIDDEN (a missing
  // permission): a timeout is temporary and self-clearing, and the client uses
  // the code to say so rather than showing a generic refusal.
  | "TIMED_OUT"
  | "RATE_LIMITED"
  | "SLOWMODE"
  // STATE RESYNC: GET /voice/occupancy when the media plane (LiveKit) is
  // unreachable — the client keeps its current view and retries, never wiped.
  | "VOICE_OCCUPANCY_UNAVAILABLE"
  // M20 wave 2 (ADR 0016) watch-party search. Three codes because the three
  // failures clear on completely different timescales and a client must be able
  // to say which one happened. DISABLED: no YOUTUBE_API_KEY on this deployment —
  // permanent until the founder sets one, and the reason `/watch/capabilities`
  // exists so a client never reaches this by pressing something. QUOTA: the
  // per-user or the deployment-wide daily allowance is spent; clears at
  // YouTube's midnight. UNAVAILABLE: the upstream call failed; may clear in a
  // minute. Every one of them leaves the paste-a-link path working.
  | "WATCH_SEARCH_DISABLED"
  | "WATCH_SEARCH_QUOTA"
  | "WATCH_SEARCH_UNAVAILABLE"
  // M19 GIF proxy (Tenor). GIF_DISABLED: no TENOR_API_KEY on this deployment.
  // GIF_UPSTREAM_ERROR: Tenor API returned an error.
  | "GIF_DISABLED"
  | "GIF_UPSTREAM_ERROR"
  // Client-identity gate (plugins/client-gate.ts): the request carries no
  // `x-demli-client` mark while the gate is armed, i.e. it came from an app built
  // by a retired build. Served with HTTP 426 and a `downloadUrl` detail —
  // the ONE error whose remedy is "install a different application", which is why
  // it is not FORBIDDEN or UNAUTHORIZED: nothing about the session is wrong.
  | "CLIENT_UPDATE_REQUIRED"
  | "INTERNAL";

/** Extra structured fields carried on an error body (e.g. ACCOUNT_FROZEN's purgeAt). */
export type ApiErrorDetails = Record<string, unknown>;

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    /** SLOWMODE only: seconds until the client may retry (rendered in the body). */
    readonly retryAfterSeconds?: number,
    /** Extra structured fields merged into `error` (e.g. `{ purgeAt }`, M15). */
    readonly details?: ApiErrorDetails,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    retryAfterSeconds?: number;
  } & ApiErrorDetails;
}

export function errorBody(
  code: ApiErrorCode,
  message: string,
  retryAfterSeconds?: number,
  details?: ApiErrorDetails,
): ApiErrorBody {
  return {
    error: {
      code,
      message,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      ...(details ?? {}),
    },
  };
}

/** Validate unknown input at the boundary; throw a friendly 400 on failure. */
export function parseWith<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      issue ? `${path}${issue.message}` : "Invalid input.",
    );
  }
  return result.data;
}
