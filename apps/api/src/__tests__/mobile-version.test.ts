/**
 * GET /mobile/version (native-update prompt) — route tests.
 *
 * One public, env-fed route: it tells a sideloaded install which native runtime
 * is current, where the APK lives, and (optionally) the floor below which the
 * client blocks. No DB is touched (the route reads env only), matching the
 * injected-repos style of the eas-webhook tests.
 */

import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Repositories } from "@demli/db";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";

const DB_URL = "postgresql://postgres:postgres@localhost:5432/demli";

async function appWith(env: Record<string, string | undefined>): Promise<FastifyInstance> {
  return buildApp({
    repos: {} as unknown as Repositories,
    env: loadEnv({ DATABASE_URL: DB_URL, ...env }),
    logger: false,
  });
}

describe("GET /mobile/version", () => {
  it("serves the built-in defaults when nothing is configured", async () => {
    const app = await appWith({});
    const res = await app.inject({ method: "GET", url: "/mobile/version" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      latestRuntimeVersion: "1.3.0",
      apkUrl: "https://api.getdemli.com/dl/mobile/demli.apk",
    });
    // No floor configured ⇒ the field must be absent (advisory-only client side).
    expect(res.json()).not.toHaveProperty("minSupportedRuntimeVersion");
    await app.close();
  });

  it("serves the configured latest runtime and APK url", async () => {
    const app = await appWith({
      MOBILE_LATEST_RUNTIME: "2.0.0",
      MOBILE_APK_URL: "https://dl.example.com/demli.apk",
    });
    const res = await app.inject({ method: "GET", url: "/mobile/version" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      latestRuntimeVersion: "2.0.0",
      apkUrl: "https://dl.example.com/demli.apk",
    });
    await app.close();
  });

  it("advertises minSupportedRuntimeVersion only when configured", async () => {
    const app = await appWith({ MOBILE_MIN_RUNTIME: "1.1.0" });
    const res = await app.inject({ method: "GET", url: "/mobile/version" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      latestRuntimeVersion: "1.3.0",
      minSupportedRuntimeVersion: "1.1.0",
    });
    await app.close();
  });

  it("treats a blank MOBILE_MIN_RUNTIME as no floor at all", async () => {
    const app = await appWith({ MOBILE_MIN_RUNTIME: "" });
    const res = await app.inject({ method: "GET", url: "/mobile/version" });

    expect(res.json()).not.toHaveProperty("minSupportedRuntimeVersion");
    await app.close();
  });

  it("requires no authentication (pre-auth, every cold launch)", async () => {
    const app = await appWith({});
    const res = await app.inject({
      method: "GET",
      url: "/mobile/version",
      // Deliberately no Authorization header — the route must still answer 200.
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
