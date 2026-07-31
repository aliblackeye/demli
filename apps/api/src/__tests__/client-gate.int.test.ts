/**
 * Client-identity gate — HTTP half.
 *
 * Asserts the three things that decide whether this switch is safe to arm on a
 * live product with real users:
 *   1. DISARMED BY DEFAULT. Unset / empty / "true" / "1" / "ON " all pass traffic.
 *   2. When armed, an unmarked request is refused with 426 + a typed body, and a
 *      marked one is let through to the normal handler.
 *   3. The exemptions hold — /health, /mobile/version, /hooks/* and every CORS
 *      preflight stay reachable, so a refused client can still learn what to
 *      install. Break these and the gate is a dead end.
 *
 * No DB: every assertion is about the `onRequest` hook, which runs before any
 * handler touches repositories. Routes that WOULD need a database are probed only
 * for "was I refused by the gate", never for their own success.
 */

import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Repositories } from "@demli/db";
import {
  CLIENT_SIGNATURE_HEADER,
  CLIENT_UPDATE_REQUIRED_STATUS,
  isClientGateEnabled,
} from "@demli/config";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import { isGateExempt } from "../plugins/client-gate.js";

const DB_URL = "postgresql://postgres:postgres@localhost:5432/demli";

/** A route that exists, needs auth, and is NOT exempt — the gate's normal target. */
const GATED_ROUTE = "/groups";

async function appWith(env: Record<string, string | undefined>): Promise<FastifyInstance> {
  return buildApp({
    repos: {} as unknown as Repositories,
    env: loadEnv({ DATABASE_URL: DB_URL, ...env }),
    logger: false,
  });
}

const armed = (): Promise<FastifyInstance> => appWith({ CLIENT_GATE: "on" });

describe("client gate — disarmed by default", () => {
  it("passes an unmarked request when CLIENT_GATE is unset", async () => {
    const app = await appWith({});
    const res = await app.inject({ method: "GET", url: GATED_ROUTE });

    // 401 (no session) is the PRE-EXISTING behaviour. What matters is that it is
    // not 426: the gate did not touch this request.
    expect(res.statusCode).not.toBe(CLIENT_UPDATE_REQUIRED_STATUS);
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it.each(["", " ", "off", "true", "1", "yes", "ON ", "On", "onn"])(
    "stays disarmed for CLIENT_GATE=%j",
    async (value) => {
      const app = await appWith({ CLIENT_GATE: value });
      const res = await app.inject({ method: "GET", url: GATED_ROUTE });

      expect(res.statusCode).not.toBe(CLIENT_UPDATE_REQUIRED_STATUS);
      await app.close();
    },
  );

  it('arms on the literal "on" and nothing else', () => {
    expect(isClientGateEnabled("on")).toBe(true);
    // No trimming, no case folding, no truthiness — see the function's comment
    // for why leniency here is the dangerous direction.
    for (const value of [
      "",
      " on ",
      "on ",
      "ON",
      "On",
      "true",
      "1",
      "yes",
      "enabled",
      "off",
      undefined,
      null,
      1,
      true,
    ]) {
      expect(isClientGateEnabled(value)).toBe(false);
    }
  });
});

describe("client gate — armed", () => {
  it("refuses an unmarked request with 426 and a typed body", async () => {
    const app = await armed();
    const res = await app.inject({ method: "GET", url: GATED_ROUTE });

    expect(res.statusCode).toBe(426);
    expect(res.json()).toMatchObject({
      error: {
        code: "CLIENT_UPDATE_REQUIRED",
        downloadUrl: "https://getdemli.com",
      },
    });
    expect(typeof res.json().error.message).toBe("string");
    await app.close();
  });

  it("refuses BEFORE authentication — an old client cannot even sign in", async () => {
    const app = await armed();
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "someone@example.com", password: "hunter22" },
    });

    // Not 401/400/500: the gate short-circuits the login route entirely, so no
    // credential is ever checked and no session can be minted.
    expect(res.statusCode).toBe(426);
    expect(res.json().error.code).toBe("CLIENT_UPDATE_REQUIRED");
    await app.close();
  });

  it("lets a marked request through to the normal handler", async () => {
    const app = await armed();
    const res = await app.inject({
      method: "GET",
      url: GATED_ROUTE,
      headers: { [CLIENT_SIGNATURE_HEADER]: "demli-desktop/0.0.81" },
    });

    // Reaches auth, which rejects it for the ordinary reason. The gate is out of
    // the way — that is the assertion.
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it.each(["demli-desktop/0.0.81", "demli-mobile/2.0.0", "demli-web/1"])(
    "accepts the mark %s",
    async (signature) => {
      const app = await armed();
      const res = await app.inject({
        method: "GET",
        url: GATED_ROUTE,
        headers: { [CLIENT_SIGNATURE_HEADER]: signature },
      });

      expect(res.statusCode).not.toBe(426);
      await app.close();
    },
  );

  it.each(["", "  ", "demli-desktop", "other-desktop/1.0.0", "Demli-Desktop/1", "demli/1.0"])(
    "still refuses the malformed mark %j",
    async (signature) => {
      const app = await armed();
      const res = await app.inject({
        method: "GET",
        url: GATED_ROUTE,
        headers: { [CLIENT_SIGNATURE_HEADER]: signature },
      });

      expect(res.statusCode).toBe(426);
      await app.close();
    },
  );

  it("refuses an absurdly long mark instead of matching it", async () => {
    const app = await armed();
    const res = await app.inject({
      method: "GET",
      url: GATED_ROUTE,
      headers: { [CLIENT_SIGNATURE_HEADER]: `demli-desktop/${"9".repeat(4000)}` },
    });

    expect(res.statusCode).toBe(426);
    await app.close();
  });
});

describe("client gate — exemptions (the escape hatch)", () => {
  it("leaves /health reachable", async () => {
    const app = await armed();
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    await app.close();
  });

  it("leaves /mobile/version reachable — a refused client's only map", async () => {
    const app = await armed();
    const res = await app.inject({ method: "GET", url: "/mobile/version" });

    expect(res.statusCode).toBe(200);
    expect(typeof res.json().apkUrl).toBe("string");
    await app.close();
  });

  it("leaves the CORS preflight reachable — a browser sends no custom header on OPTIONS", async () => {
    const app = await armed();
    const res = await app.inject({
      method: "OPTIONS",
      url: GATED_ROUTE,
      headers: {
        origin: "https://app.getdemli.com",
        "access-control-request-method": "GET",
        "access-control-request-headers": CLIENT_SIGNATURE_HEADER,
      },
    });

    expect(res.statusCode).not.toBe(426);
    expect(res.statusCode).toBeLessThan(300);
    await app.close();
  });

  it("leaves /hooks/* reachable — the EAS webhook signs itself and sends no mark", async () => {
    const app = await armed();
    const res = await app.inject({
      method: "POST",
      url: "/hooks/eas-build",
      payload: {},
    });

    // The webhook route is unregistered without EAS_WEBHOOK_SECRET, so 404 is the
    // correct pre-existing answer. 426 would mean the gate ate it.
    expect(res.statusCode).not.toBe(426);
    await app.close();
  });

  it("exempts query-string and preflight variants at the predicate level", () => {
    expect(isGateExempt("GET", "/health")).toBe(true);
    expect(isGateExempt("GET", "/mobile/version?rt=2.0.0")).toBe(true);
    expect(isGateExempt("POST", "/hooks/eas-build")).toBe(true);
    expect(isGateExempt("OPTIONS", "/groups")).toBe(true);

    // …and does NOT exempt lookalikes. A prefix match on "/health" would open
    // "/healthcheck-proxy" and, worse, anything a route named "/mobile/versions"
    // grows into later.
    expect(isGateExempt("GET", "/groups")).toBe(false);
    expect(isGateExempt("GET", "/healthz")).toBe(false);
    expect(isGateExempt("GET", "/mobile/versions")).toBe(false);
    expect(isGateExempt("GET", "/auth/login")).toBe(false);
  });
});
