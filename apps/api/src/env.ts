import { z } from "zod";
import { DEFAULT_API_PORT, isClientGateEnabled } from "@demli/config";

/**
 * Environment parsing at the process boundary. Defaults target the local
 * docker-compose stack; real deployments must set everything explicitly.
 * Secrets come from the environment only — never from code (CLAUDE.md §28).
 *
 * The dev defaults are convenient locally but must NEVER reach production. When
 * APP_ENV=production the schema fails fast (security-review M5) if a secret is
 * missing (falls back to a dev default), still equals a dev default
 * (`devkey`/`devsecret`), or still holds a committed placeholder
 * (`REPLACE_WITH_*` / `dev-only-change-me`). The same rejection is mirrored in
 * scripts/deploy.sh so a bad value is caught before the stack starts.
 */
const DEV_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/demli";
const PLACEHOLDER_PATTERN = /REPLACE_WITH|dev-only-change-me|changeme/i;
/** Secret env keys whose dev default must not survive into production. */
const PROD_FORBIDDEN_DEFAULTS: Record<string, string> = {
  LIVEKIT_API_KEY: "devkey",
  LIVEKIT_API_SECRET: "devsecret",
};

/**
 * First-party BROWSER origins that are always allowed to call this API, merged
 * on top of whatever `CORS_ORIGIN` holds.
 *
 * Kept in git (like MOBILE_APK_URL below) so adding or moving a public web host
 * is one commit + deploy instead of a hand-edit of `.env.prod` on the VPS — the
 * failure mode of the alternative is a silently CORS-blocked web client.
 *
 * The web app is served from `app.getdemli.com` and the API from
 * `api.getdemli.com`, so every web request is cross-origin. Native clients are
 * unaffected either way — packaged Electron sends `Origin: null`/`file://` and
 * React Native sends none, and for them the Bearer session token is the security
 * boundary, not CORS (see `apps/api/src/app.ts`).
 *
 * ONLY LIVE HOSTS WE CONTROL BELONG HERE. The old `demli.karagozali.com` sat in
 * this list through the phased domain move and was removed once that domain's
 * DNS was deleted (2026-07-27): a hostname we no longer control is not dead
 * weight, it is a credentialed-CORS grant waiting for whoever registers it next.
 * Retiring a domain means deleting it here in the same breath.
 *
 * This list only ever WIDENS the allowlist; it cannot break an existing
 * deployment. A `CORS_ORIGIN` of `*` still wins (any origin is reflected).
 */
const FIRST_PARTY_WEB_ORIGINS = [
  "https://app.getdemli.com",
  "https://getdemli.com",
  "https://www.getdemli.com",
];

/** Parse CORS_ORIGIN and fold in the first-party web origins (deduped). */
function resolveCorsOrigins(raw: string): string[] {
  const configured = raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  // Wildcard short-circuits: app.ts reflects any origin, so adding entries
  // would be noise.
  if (configured.includes("*")) return configured;
  return [...new Set([...configured, ...FIRST_PARTY_WEB_ORIGINS])];
}

const apiEnvSchema = z
  .object({
    /** Production flag — activates the fail-fast secret checks below. */
    APP_ENV: z.string().min(1).default("development"),
    PORT: z.coerce.number().int().positive().default(DEFAULT_API_PORT),
    HOST: z.string().min(1).default("127.0.0.1"),
    DATABASE_URL: z.string().url().default(DEV_DATABASE_URL),
    /** Redis for the api→realtime mutation pub/sub bridge (edit/delete fan-out). */
    REDIS_URL: z.string().url().default("redis://localhost:6379"),
    /**
     * Comma-separated allowlist of renderer origins. FIRST_PARTY_WEB_ORIGINS
     * (above) is always merged in on top of this, so the public web hosts never
     * depend on a hand-edited `.env.prod`. `*` reflects any origin.
     */
    CORS_ORIGIN: z.string().min(1).default("http://localhost:5173"),
    SESSION_TTL_HOURS: z.coerce.number().positive().max(24 * 365).default(24 * 7),
    /**
     * Google OAuth (0010) — accepted ID-token audiences. Comma-separated so the
     * later web + Android + iOS client IDs can all be trusted at once. OPTIONAL:
     * when unset, `POST /auth/google` is disabled (answers 501 GOOGLE_AUTH_DISABLED)
     * and boot is unaffected. Not a secret — a client id is public — so no
     * production placeholder check is needed.
     */
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    /** LiveKit SFU — defaults match docker-compose dev mode (LIVEKIT_KEYS). */
    LIVEKIT_URL: z.string().min(1).default("ws://localhost:7880"),
    LIVEKIT_API_KEY: z.string().min(1).default("devkey"),
    LIVEKIT_API_SECRET: z.string().min(1).default("devsecret"),
    /**
     * Supabase Storage for media attachments (ADR 0008). All three are OPTIONAL:
     * when any is absent the attachments feature is disabled (the storage
     * wrapper is not constructed and the endpoints answer ATTACHMENTS_DISABLED).
     * The service key is the ONLY secret that unlocks the bucket — it lives here
     * (server-side) and never reaches a client (§28).
     */
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_SERVICE_KEY: z.string().min(1).optional(),
    SUPABASE_STORAGE_BUCKET: z.string().min(1).optional(),
    /**
     * Avatar uploads (profile photos) — a SEPARATE, PUBLIC bucket from the
     * signed attachment bucket above (avatars are served as stable public URLs
     * stored on the user row, never signed per read). OFF BY DEFAULT: when unset
     * `POST /users/me/avatar` answers 503 AVATAR_UPLOADS_DISABLED and nothing
     * about the running server changes. Reuses SUPABASE_URL + SUPABASE_SERVICE_KEY;
     * the founder need only create a public bucket and set this ONE name to turn
     * the feature on. Deliberately additive so production is untouched until then.
     */
    SUPABASE_AVATAR_BUCKET: z.string().min(1).optional(),
    /**
     * Media moderation MODE (NSFW seam, M15). The single on/off switch the founder
     * asked for: "off" (default) ⇒ the seam is a no-op, ALL image uploads pass
     * (fail-open), and nothing is ever rejected for NSFW. Any other value ("on", or
     * a future model name) turns the seam ON — it then dynamically imports
     * {@link MEDIA_MODERATION_MODULE} to screen images. No ML model is bundled;
     * flipping this env is the entire cost of enabling/disabling moderation later.
     */
    MEDIA_MODERATION_MODE: z.string().min(1).default("off"),
    /**
     * YouTube Data API v3 key for in-app watch-party search (M20 wave 2, ADR
     * 0016). OPTIONAL, and its absence is a supported, tested state: unset ⇒
     * `GET /watch/search` answers 503 WATCH_SEARCH_DISABLED and, more
     * importantly, `GET /watch/capabilities` answers `searchEnabled: false` so
     * clients render the paste-a-link path instead of a search box that cannot
     * work (§35). Nothing else about the server changes, and watch parties keep
     * working exactly as they do today — playback has never needed a key.
     *
     * It is a SECRET in the sense that matters: it is not a password, but it
     * spends OUR quota (10,000 units/day, 100 per search), so it stays
     * server-side and is never sent to a client. No production placeholder check
     * — an unset key is a legitimate production configuration here, unlike
     * LIVEKIT_API_SECRET.
     */
    YOUTUBE_API_KEY: z.string().min(1).optional(),
    /**
     * RUNTIME module specifier the moderation seam dynamically `import()`s when
     * {@link MEDIA_MODERATION_MODE} is on. The module exposes
     * `moderateImage(input) => { nsfw, score? }` (or a default export). UNSET while
     * mode is on ⇒ the seam still fails open (nothing to call). Falls back to the
     * legacy `AVATAR_MODERATION_MODULE` for back-compat. Deliberately a runtime
     * string so no model is statically bundled into the API image.
     */
    MEDIA_MODERATION_MODULE: z.string().min(1).optional(),
    /** @deprecated Legacy alias for MEDIA_MODERATION_MODULE (pre-M15 avatar-only seam). */
    AVATAR_MODERATION_MODULE: z.string().min(1).optional(),
    /**
     * EAS Build webhook (task #39) — auto-refreshes the fixed public APK. When
     * unset the webhook route is NOT registered (feature disabled → 404). Expo
     * requires the signing secret to be at least 16 characters; a shorter value
     * is a misconfiguration, so fail fast at boot.
     */
    EAS_WEBHOOK_SECRET: z.string().min(16, "EAS_WEBHOOK_SECRET must be at least 16 characters.").optional(),
    /** Directory the refreshed demli.apk is written to (mounted from the host). */
    APK_OUTPUT_DIR: z.string().min(1).default("/data/dl-mobile"),
    /** SSRF allowlist prefix for EAS artifact downloads. */
    EAS_ARTIFACT_URL_PREFIX: z.string().url().default("https://expo.dev/artifacts/"),
    /**
     * Native-update advertisement (sideloaded APK, task "native-update-prompt").
     * GET /mobile/version serves these three values so an OLD installed APK can
     * discover a newer NATIVE runtime it cannot receive over OTA and prompt the
     * user to reinstall from the fixed download link. All three are plain config
     * (no secret, no migration): the client does the semver comparison locally.
     *
     * - MOBILE_LATEST_RUNTIME: the newest shipped `runtimeVersion` (app.json).
     * - MOBILE_APK_URL: the stable public APK download link (served by Caddy at
     *   /dl/mobile/demli.apk and kept fresh by the EAS webhook above). The
     *   filename is shared with the Caddy /download/android redirect, FINAL_NAME
     *   in modules/hooks/download.ts and scripts/publish-mobile-apk.sh —
     *   scripts/check-caddyfile.mjs ("apk-alias") fails when they disagree.
     * - MOBILE_MIN_RUNTIME: OPTIONAL floor — installs older than this are forced
     *   to update (hard block); unset ⇒ the update is only ever advisory.
     *
     * The production value is PINNED in docker-compose.prod.yml (like
     * MOBILE_LATEST_RUNTIME) so a rename ships as one commit + deploy instead of
     * a hand-edit of .env.prod on the VPS. This default is the dev/local one.
     */
    MOBILE_LATEST_RUNTIME: z.string().min(1).default("1.3.0"),
    MOBILE_APK_URL: z.string().url().default("https://api.getdemli.com/dl/mobile/demli.apk"),
    MOBILE_MIN_RUNTIME: z.string().min(1).optional(),
    /**
     * Client-identity gate. ONLY the exact value
     * "on" arms it; unset, empty, "true", "1" or a typo all leave it DISARMED —
     * see `isClientGateEnabled` in @demli/config for why the switch is that
     * narrow. Kept as a free-form string here so a wrong value is inert instead
     * of a boot failure: this env decides whether real users can reach the
     * server, and its safe state must never depend on parsing succeeding.
     *
     * Deliberately NOT pinned in docker-compose.prod.yml — it is interpolated
     * from .env.prod, so arming the gate is an operator action on the VPS that
     * no commit can perform by accident.
     */
    CLIENT_GATE: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.APP_ENV !== "production") return;

    const reject = (key: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message });
    };

    for (const [key, devDefault] of Object.entries(PROD_FORBIDDEN_DEFAULTS)) {
      const value = env[key as "LIVEKIT_API_KEY" | "LIVEKIT_API_SECRET"];
      if (value === devDefault) {
        reject(key, `${key} is the insecure dev default in production. Set a real secret.`);
      } else if (PLACEHOLDER_PATTERN.test(value)) {
        reject(key, `${key} still holds a placeholder value in production. Set a real secret.`);
      }
    }

    if (env.DATABASE_URL === DEV_DATABASE_URL) {
      reject("DATABASE_URL", "DATABASE_URL is the local dev default in production. Set the real database URL.");
    }
    if (!env.REDIS_URL.includes("@")) {
      reject(
        "REDIS_URL",
        "REDIS_URL has no credentials in production. Production Redis requires a password (redis://:PASSWORD@host).",
      );
    }

    // Supabase is optional (attachments off when unset), but a value that is
    // still the committed placeholder in production is a misconfiguration — the
    // feature would appear enabled yet every signed-URL call would fail. Reject
    // it the same way as the LiveKit placeholders so a copied-but-unfilled
    // .env.prod is caught at boot, not at first upload.
    if (env.SUPABASE_URL && env.SUPABASE_URL.includes("your-project-ref")) {
      reject("SUPABASE_URL", "SUPABASE_URL still holds the placeholder in production. Set the real project URL or leave it unset to disable attachments.");
    }
    if (
      env.SUPABASE_SERVICE_KEY &&
      (PLACEHOLDER_PATTERN.test(env.SUPABASE_SERVICE_KEY) ||
        /change[-_]?me/i.test(env.SUPABASE_SERVICE_KEY))
    ) {
      reject("SUPABASE_SERVICE_KEY", "SUPABASE_SERVICE_KEY still holds a placeholder in production. Set the real service key or leave it unset to disable attachments.");
    }

    // The webhook is optional, but a committed placeholder in production would
    // silently reject every real Expo delivery (signatures would never match).
    if (env.EAS_WEBHOOK_SECRET && PLACEHOLDER_PATTERN.test(env.EAS_WEBHOOK_SECRET)) {
      reject("EAS_WEBHOOK_SECRET", "EAS_WEBHOOK_SECRET still holds a placeholder in production. Set the real secret or leave it unset to disable the webhook.");
    }
  });

export interface ApiEnv {
  port: number;
  host: string;
  databaseUrl: string;
  redisUrl: string;
  corsOrigins: string[];
  sessionTtlHours: number;
  /**
   * Accepted Google ID-token audiences (0010). Empty ⇒ Google sign-in disabled;
   * a non-empty list enables `POST /auth/google` with these as the audience.
   */
  googleClientIds: string[];
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  /** Supabase Storage config for attachments; undefined ⇒ feature disabled. */
  supabaseUrl?: string;
  supabaseServiceKey?: string;
  supabaseStorageBucket?: string;
  /** Public avatar bucket name; undefined ⇒ avatar/banner uploads disabled (503). */
  supabaseAvatarBucket?: string;
  /** Media moderation on/off (M15). "off" (default) ⇒ fail-open no-op seam. */
  mediaModerationMode: string;
  /** Runtime module specifier for the NSFW seam; undefined ⇒ no-op (skipped). */
  mediaModerationModule?: string;
  /**
   * YouTube Data API key (M20 wave 2); undefined ⇒ in-app watch-party search is
   * disabled and `/watch/capabilities` reports `searchEnabled: false`. Playback
   * and the paste-a-link path are unaffected — they never needed a key.
   */
  youtubeApiKey?: string;
  /** EAS webhook signing secret; undefined ⇒ webhook route disabled (404). */
  easWebhookSecret?: string;
  /** Target directory for the auto-refreshed demli.apk. */
  apkOutputDir: string;
  /** SSRF allowlist prefix for EAS artifact URLs. */
  easArtifactUrlPrefix: string;
  /** Newest shipped native runtimeVersion advertised at GET /mobile/version. */
  mobileLatestRuntime: string;
  /** Stable public APK download link advertised at GET /mobile/version. */
  mobileApkUrl: string;
  /** Optional forced-update floor; undefined ⇒ native update is advisory only. */
  mobileMinRuntime?: string;
  /**
   * Client-identity gate armed?. False unless
   * CLIENT_GATE is exactly "on". When true, every non-exempt request without a
   * valid `x-demli-client` mark is refused with 426 — see
   * `plugins/client-gate.ts`.
   */
  clientGate: boolean;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  const parsed = apiEnvSchema.parse({
    APP_ENV: source["APP_ENV"],
    PORT: source["PORT"],
    HOST: source["HOST"],
    DATABASE_URL: source["DATABASE_URL"],
    REDIS_URL: source["REDIS_URL"],
    CORS_ORIGIN: source["CORS_ORIGIN"],
    SESSION_TTL_HOURS: source["SESSION_TTL_HOURS"],
    // Empty string ⇒ treat as unset so blanking the line disables Google sign-in.
    GOOGLE_CLIENT_ID: source["GOOGLE_CLIENT_ID"] || undefined,
    LIVEKIT_URL: source["LIVEKIT_URL"],
    LIVEKIT_API_KEY: source["LIVEKIT_API_KEY"],
    LIVEKIT_API_SECRET: source["LIVEKIT_API_SECRET"],
    SUPABASE_URL: source["SUPABASE_URL"],
    SUPABASE_SERVICE_KEY: source["SUPABASE_SERVICE_KEY"],
    SUPABASE_STORAGE_BUCKET: source["SUPABASE_STORAGE_BUCKET"],
    // Empty string ⇒ treat as unset so blanking the line disables the feature.
    SUPABASE_AVATAR_BUCKET: source["SUPABASE_AVATAR_BUCKET"] || undefined,
    // Empty string ⇒ treat as unset so blanking the line falls back to the "off" default.
    MEDIA_MODERATION_MODE: source["MEDIA_MODERATION_MODE"] || undefined,
    MEDIA_MODERATION_MODULE: source["MEDIA_MODERATION_MODULE"] || undefined,
    AVATAR_MODERATION_MODULE: source["AVATAR_MODERATION_MODULE"] || undefined,
    // Empty string ⇒ treat as unset, so blanking the line is how the founder
    // turns in-app search back OFF without editing code.
    YOUTUBE_API_KEY: source["YOUTUBE_API_KEY"] || undefined,
    // Empty string ⇒ treat as unset so blanking a line in .env means "disabled"
    // (secret) / "use default" (dir, prefix) instead of failing min-length/url.
    EAS_WEBHOOK_SECRET: source["EAS_WEBHOOK_SECRET"] || undefined,
    APK_OUTPUT_DIR: source["APK_OUTPUT_DIR"] || undefined,
    EAS_ARTIFACT_URL_PREFIX: source["EAS_ARTIFACT_URL_PREFIX"] || undefined,
    MOBILE_LATEST_RUNTIME: source["MOBILE_LATEST_RUNTIME"] || undefined,
    MOBILE_APK_URL: source["MOBILE_APK_URL"] || undefined,
    // Empty string ⇒ treat as unset so blanking the line means "no forced floor".
    MOBILE_MIN_RUNTIME: source["MOBILE_MIN_RUNTIME"] || undefined,
    // Passed through raw; `isClientGateEnabled` is the only thing that decides
    // what counts as armed, and it accepts exactly one value.
    CLIENT_GATE: source["CLIENT_GATE"] || undefined,
  });
  return {
    port: parsed.PORT,
    host: parsed.HOST,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    corsOrigins: resolveCorsOrigins(parsed.CORS_ORIGIN),
    sessionTtlHours: parsed.SESSION_TTL_HOURS,
    googleClientIds: parsed.GOOGLE_CLIENT_ID
      ? parsed.GOOGLE_CLIENT_ID.split(",").map((id) => id.trim()).filter(Boolean)
      : [],
    livekitUrl: parsed.LIVEKIT_URL,
    livekitApiKey: parsed.LIVEKIT_API_KEY,
    livekitApiSecret: parsed.LIVEKIT_API_SECRET,
    supabaseUrl: parsed.SUPABASE_URL,
    supabaseServiceKey: parsed.SUPABASE_SERVICE_KEY,
    supabaseStorageBucket: parsed.SUPABASE_STORAGE_BUCKET,
    supabaseAvatarBucket: parsed.SUPABASE_AVATAR_BUCKET,
    mediaModerationMode: parsed.MEDIA_MODERATION_MODE,
    // Prefer the new specifier; fall back to the legacy avatar-only one.
    mediaModerationModule:
      parsed.MEDIA_MODERATION_MODULE ?? parsed.AVATAR_MODERATION_MODULE,
    youtubeApiKey: parsed.YOUTUBE_API_KEY,
    easWebhookSecret: parsed.EAS_WEBHOOK_SECRET,
    apkOutputDir: parsed.APK_OUTPUT_DIR,
    easArtifactUrlPrefix: parsed.EAS_ARTIFACT_URL_PREFIX,
    mobileLatestRuntime: parsed.MOBILE_LATEST_RUNTIME,
    mobileApkUrl: parsed.MOBILE_APK_URL,
    mobileMinRuntime: parsed.MOBILE_MIN_RUNTIME,
    clientGate: isClientGateEnabled(parsed.CLIENT_GATE),
  };
}
