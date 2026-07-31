/**
 * Server-side media moderation seam (NSFW) — the generalized successor to the
 * avatar-only seam (M15). ONE pluggable interface screens three subjects:
 *   - "avatar"     — profile photo bytes (always screened; a profile is never NSFW)
 *   - "banner"     — profile banner bytes (always screened; same rule)
 *   - "attachment" — a message IMAGE attachment, screened ONLY when its channel is
 *                    NOT flagged NSFW (NSFW media belongs in an NSFW channel;
 *                    elsewhere it is blocked with `nsfw_content_blocked`).
 *
 * Why server-side and not client-side: an earlier attempt wired nsfwjs+tfjs into
 * the renderer — ~40 MB of model shards, and trivially bypassable (a crafted
 * request skips it). The check therefore lives HERE, on the upload/complete path,
 * BEFORE bytes are linked to a message or persisted on a profile, so it cannot be
 * bypassed once enabled.
 *
 * Why a seam and not a bundled model: shipping an ML model inside the API image is
 * its own weight/ops problem, and the founder has not yet chosen a provider
 * (hosted moderation API vs. self-hosted model). So the real check is a RUNTIME
 * module specifier (`MEDIA_MODERATION_MODULE`) dynamically `import()`ed only when
 * `MEDIA_MODERATION_MODE` is enabled — nothing is statically bundled. THIS FILE
 * DELIBERATELY DOES NOT IMPLEMENT A MODEL; it is the seam + flow + typed result.
 *
 * Default posture is FAIL-OPEN: mode "off"/unset ⇒ a no-op that returns `skipped`
 * and everything proceeds. A configured module that throws (bad import, model
 * error, timeout) ALSO yields `skipped` — a moderation outage must never block a
 * profile edit or a message send. Only an explicit `{ nsfw: true }` from a live
 * module produces `rejected`.
 *
 * The module contract (default export that IS the function, or a named
 * `moderateImage` export):
 *   (input: MediaModerationInput) => Promise<{ nsfw: boolean; score?: number }>
 *                                  |         { nsfw: boolean; score?: number }
 */

/** What is being screened — a module may apply different thresholds per subject. */
export type MediaModerationSubject = "avatar" | "banner" | "attachment";

export interface MediaModerationInput {
  /** Raw bytes when the API holds them (avatar, banner). Mutually informative with `url`. */
  bytes?: Uint8Array;
  /** A fetchable (signed) URL when the object already lives in storage (attachment). */
  url?: string;
  /** The declared/known MIME of the image. */
  mime: string;
  /** Which upload path this is (see {@link MediaModerationSubject}). */
  subject: MediaModerationSubject;
}

export type MediaModerationVerdict = "allowed" | "rejected" | "skipped";

export interface MediaModerationResult {
  verdict: MediaModerationVerdict;
  /** The module's raw nsfw flag when it ran; undefined when skipped. */
  nsfw?: boolean;
  /** Optional confidence score (0..1) from the module. */
  score?: number;
  /** Human-readable reason, for logs. Never trusted from a client. */
  reason?: string;
  /** Present only when a configured module threw — surfaced for logging, never to a client. */
  error?: unknown;
}

/** The shape a configured moderation module must expose. */
type MediaModerationFn = (
  input: MediaModerationInput,
) =>
  | Promise<{ nsfw: boolean; score?: number }>
  | { nsfw: boolean; score?: number };

export interface MediaModerator {
  /**
   * True when a real module is wired AND the mode is on. Lets the ATTACHMENT path
   * skip the extra signed-URL round trip when moderation is off (avatar/banner
   * always call `check` regardless, since their bytes are already in hand).
   */
  readonly enabled: boolean;
  /** Screen one image. NEVER throws — a failure fails open (`skipped`). */
  check(input: MediaModerationInput): Promise<MediaModerationResult>;
}

/** Resolve the callable from a dynamically-imported module (default export or `moderateImage`). */
function resolveModerationFn(mod: unknown): MediaModerationFn | null {
  if (typeof mod === "function") return mod as MediaModerationFn;
  if (mod && typeof mod === "object") {
    const record = mod as Record<string, unknown>;
    if (typeof record["default"] === "function") return record["default"] as MediaModerationFn;
    if (typeof record["moderateImage"] === "function") {
      return record["moderateImage"] as MediaModerationFn;
    }
  }
  return null;
}

const NOOP_MODERATOR: MediaModerator = {
  enabled: false,
  async check(): Promise<MediaModerationResult> {
    return { verdict: "skipped", reason: "media moderation disabled" };
  },
};

/**
 * Build the media moderator from env. `mode` "off"/undefined ⇒ the no-op
 * (fail-open) moderator. Otherwise a moderator that lazily imports
 * `moduleSpecifier` once, then delegates; any thrown error (bad import, model
 * failure) also returns `skipped` with the error attached for logging. When
 * `mode` is on but no `moduleSpecifier` is set, `enabled` is false and `check`
 * always skips — there is nothing to call.
 */
export function createMediaModerator(env: {
  mediaModerationMode?: string;
  mediaModerationModule?: string;
}): MediaModerator {
  const mode = (env.mediaModerationMode ?? "off").toLowerCase();
  const specifier = env.mediaModerationModule;

  if (mode === "off" || !mode) return NOOP_MODERATOR;
  if (!specifier) {
    // Mode on but nothing to call — fail open, and cheaply (enabled: false so the
    // attachment path does not build a signed URL for a check that always skips).
    return {
      enabled: false,
      async check(): Promise<MediaModerationResult> {
        return { verdict: "skipped", reason: "media moderation on but no module configured" };
      },
    };
  }

  // Import once, lazily, memoized (including a failed import — a broken specifier
  // is not retried on every upload).
  let fnPromise: Promise<MediaModerationFn | null> | null = null;
  const loadFn = (): Promise<MediaModerationFn | null> => {
    if (!fnPromise) {
      fnPromise = import(specifier).then(resolveModerationFn).catch(() => null);
    }
    return fnPromise;
  };

  return {
    enabled: true,
    async check(input: MediaModerationInput): Promise<MediaModerationResult> {
      try {
        const fn = await loadFn();
        if (!fn) {
          return {
            verdict: "skipped",
            reason: `moderation module '${specifier}' exposed no callable`,
          };
        }
        const result = await fn(input);
        if (result && result.nsfw === true) {
          return { verdict: "rejected", nsfw: true, score: result.score, reason: "flagged nsfw" };
        }
        return { verdict: "allowed", nsfw: false, score: result?.score };
      } catch (error) {
        // Fail open: a moderation outage must never block an upload / send.
        return { verdict: "skipped", reason: "moderation module error", error };
      }
    },
  };
}
