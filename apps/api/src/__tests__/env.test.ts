import { describe, expect, it } from "vitest";
import { loadEnv } from "../env.js";

/**
 * Env fail-fast guards (security-review M5): in production the schema must
 * reject dev-default / placeholder secrets so a copied-but-unfilled .env.prod
 * cannot boot with the publicly-known "devsecret".
 */

const REAL_PROD = {
  APP_ENV: "production",
  DATABASE_URL: "postgresql://postgres:s3cret@db.abc.supabase.co:5432/postgres?sslmode=require",
  REDIS_URL: "redis://:redispass@redis:6379",
  LIVEKIT_URL: "wss://livekit.example.com",
  LIVEKIT_API_KEY: "APIabc123",
  LIVEKIT_API_SECRET: "0123456789abcdef0123456789abcdef",
  CORS_ORIGIN: "https://app.example.com",
};

describe("api loadEnv", () => {
  it("accepts dev defaults when APP_ENV is not production", () => {
    const env = loadEnv({ DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/demli" });
    expect(env.livekitApiKey).toBe("devkey");
    expect(env.livekitApiSecret).toBe("devsecret");
    // M2: default session TTL is now 7 days.
    expect(env.sessionTtlHours).toBe(24 * 7);
  });

  it("accepts fully-configured production env", () => {
    expect(() => loadEnv(REAL_PROD)).not.toThrow();
  });

  it("rejects the devkey/devsecret dev defaults in production", () => {
    expect(() => loadEnv({ ...REAL_PROD, LIVEKIT_API_SECRET: "devsecret" })).toThrow();
    expect(() => loadEnv({ ...REAL_PROD, LIVEKIT_API_KEY: "devkey" })).toThrow();
  });

  it("rejects missing LiveKit secrets in production (falls back to dev default)", () => {
    const { LIVEKIT_API_KEY: _k, LIVEKIT_API_SECRET: _s, ...noSecrets } = REAL_PROD;
    expect(() => loadEnv(noSecrets)).toThrow();
  });

  it("rejects committed REPLACE_WITH_* placeholders in production", () => {
    expect(() =>
      loadEnv({ ...REAL_PROD, LIVEKIT_API_SECRET: "REPLACE_WITH_LIVEKIT_API_SECRET" }),
    ).toThrow();
  });

  it("rejects the local dev DATABASE_URL in production", () => {
    expect(() =>
      loadEnv({ ...REAL_PROD, DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/demli" }),
    ).toThrow();
  });

  it("rejects an unauthenticated REDIS_URL in production (M6)", () => {
    expect(() => loadEnv({ ...REAL_PROD, REDIS_URL: "redis://redis:6379" })).toThrow();
  });

  /**
   * The web client is served from the brand domain while the API stays on the
   * legacy one, so every browser request is cross-origin. These origins are
   * baked into the code (not .env.prod) — a hand-edited allowlist on the VPS is
   * exactly the drift that silently CORS-blocks the web app after a domain move.
   */
  it("always allows the first-party web origins on top of CORS_ORIGIN", () => {
    const env = loadEnv(REAL_PROD);
    expect(env.corsOrigins).toContain("https://app.getdemli.com");
    expect(env.corsOrigins).toContain("https://getdemli.com");
    expect(env.corsOrigins).toContain("https://www.getdemli.com");
    // ...without dropping what the operator configured.
    expect(env.corsOrigins).toContain("https://app.example.com");
  });

  it("grants no origin on a domain we no longer control", () => {
    // `demli.karagozali.com` was first-party during the domain move and stayed
    // in the list after that domain's DNS was deleted. A CORS grant outlives the
    // hostname: whoever registers the domain next inherits credentialed
    // cross-origin reads against production. The ban is on the apex, so a
    // subdomain cannot smuggle it back in.
    const env = loadEnv(REAL_PROD);
    for (const origin of env.corsOrigins) {
      expect(origin).not.toContain("karagozali.com");
    }
  });

  it("does not duplicate an origin that is also configured explicitly", () => {
    const env = loadEnv({ ...REAL_PROD, CORS_ORIGIN: "https://app.getdemli.com" });
    expect(env.corsOrigins.filter((o) => o === "https://app.getdemli.com")).toHaveLength(1);
  });

  it("leaves a wildcard CORS_ORIGIN alone (app.ts reflects any origin)", () => {
    expect(loadEnv({ ...REAL_PROD, CORS_ORIGIN: "*" }).corsOrigins).toEqual(["*"]);
  });
});
