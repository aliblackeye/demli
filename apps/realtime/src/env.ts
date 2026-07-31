import { z } from "zod";
import { DEFAULT_REALTIME_PORT, isClientGateEnabled } from "@demli/config";

/**
 * Dev defaults are convenient locally but must never reach production. When
 * APP_ENV=production the schema fails fast (security-review M5/M6) if the
 * database URL is still the dev default or the Redis URL carries no credentials
 * (production Redis requires a password — security-review M6).
 */
const DEV_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/demli";

const realtimeEnvSchema = z
  .object({
    /** Production flag — activates the fail-fast checks below. */
    APP_ENV: z.string().min(1).default("development"),
    PORT: z.coerce.number().int().positive().default(DEFAULT_REALTIME_PORT),
    HOST: z.string().min(1).default("127.0.0.1"),
    DATABASE_URL: z.string().url().default(DEV_DATABASE_URL),
    /** Redis for presence state + the api↔realtime mutation pub/sub bridge. */
    REDIS_URL: z.string().url().default("redis://localhost:6379"),
    /**
     * LiveKit SFU admin credentials (STATE RESYNC). OPTIONAL and additive: when
     * all three are set, the gateway reads authoritative voice occupancy from the
     * media plane and pushes it as `voice.resync` on every (re)connect. When any
     * is unset the feature simply no-ops (clients fall back to the auth.succeeded
     * snapshot + the HTTP `GET /voice/occupancy` endpoint), so an existing
     * deployment that has not wired these keeps working unchanged. Same values the
     * API uses; a wrong/unreachable host degrades to a skipped resync, never a
     * boot failure — so no production fail-fast here.
     */
    LIVEKIT_URL: z.string().min(1).optional(),
    LIVEKIT_API_KEY: z.string().min(1).optional(),
    LIVEKIT_API_SECRET: z.string().min(1).optional(),
    /**
     * Client-identity gate — the WS half of the
     * same switch the API reads. ONLY the exact value "on" arms it; anything else
     * leaves it disarmed (see `isClientGateEnabled` in @demli/config).
     *
     * Free-form string rather than a boolean on purpose: a malformed value must
     * be inert, never a boot failure. The gateway is the socket every client
     * lives on, so its safe state cannot depend on parsing succeeding.
     *
     * Both services must be armed together. Arming only the API leaves an old
     * client reading chat over this socket while it can no longer send.
     */
    CLIENT_GATE: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.APP_ENV !== "production") return;
    if (env.DATABASE_URL === DEV_DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATABASE_URL"],
        message: "DATABASE_URL is the local dev default in production. Set the real database URL.",
      });
    }
    if (!env.REDIS_URL.includes("@")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["REDIS_URL"],
        message:
          "REDIS_URL has no credentials in production. Production Redis requires a password (redis://:PASSWORD@host).",
      });
    }
  });

export interface RealtimeEnv {
  port: number;
  host: string;
  databaseUrl: string;
  redisUrl: string;
  /** LiveKit admin config for `voice.resync`; undefined ⇒ feature off. */
  livekitUrl?: string;
  livekitApiKey?: string;
  livekitApiSecret?: string;
  /**
   * Client-identity gate armed? False unless CLIENT_GATE is exactly "on". When
   * true, a handshake without a valid `?client=` mark is closed with 4426.
   */
  clientGate: boolean;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): RealtimeEnv {
  const parsed = realtimeEnvSchema.parse({
    APP_ENV: source["APP_ENV"],
    PORT: source["PORT"],
    HOST: source["HOST"],
    DATABASE_URL: source["DATABASE_URL"],
    REDIS_URL: source["REDIS_URL"],
    // Empty string ⇒ treat as unset so blanking a line disables the resync reader.
    LIVEKIT_URL: source["LIVEKIT_URL"] || undefined,
    LIVEKIT_API_KEY: source["LIVEKIT_API_KEY"] || undefined,
    LIVEKIT_API_SECRET: source["LIVEKIT_API_SECRET"] || undefined,
    // Passed through raw; `isClientGateEnabled` decides what counts as armed.
    CLIENT_GATE: source["CLIENT_GATE"] || undefined,
  });
  return {
    port: parsed.PORT,
    host: parsed.HOST,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    livekitUrl: parsed.LIVEKIT_URL,
    livekitApiKey: parsed.LIVEKIT_API_KEY,
    livekitApiSecret: parsed.LIVEKIT_API_SECRET,
    clientGate: isClientGateEnabled(parsed.CLIENT_GATE),
  };
}
