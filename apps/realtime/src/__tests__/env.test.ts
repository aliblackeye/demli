import { describe, expect, it } from "vitest";
import { loadEnv } from "../env.js";

/** Production fail-fast guards (security-review M5/M6). */
describe("realtime loadEnv", () => {
  it("accepts dev defaults when APP_ENV is not production", () => {
    expect(() => loadEnv({})).not.toThrow();
  });

  it("accepts a fully-configured production env", () => {
    expect(() =>
      loadEnv({
        APP_ENV: "production",
        DATABASE_URL: "postgresql://postgres:s3cret@db.abc.supabase.co:5432/postgres?sslmode=require",
        REDIS_URL: "redis://:redispass@redis:6379",
      }),
    ).not.toThrow();
  });

  it("rejects the local dev DATABASE_URL in production", () => {
    expect(() =>
      loadEnv({
        APP_ENV: "production",
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/demli",
        REDIS_URL: "redis://:redispass@redis:6379",
      }),
    ).toThrow();
  });

  it("rejects an unauthenticated REDIS_URL in production", () => {
    expect(() =>
      loadEnv({
        APP_ENV: "production",
        DATABASE_URL: "postgresql://postgres:s3cret@db.abc.supabase.co:5432/postgres?sslmode=require",
        REDIS_URL: "redis://redis:6379",
      }),
    ).toThrow();
  });
});
