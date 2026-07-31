/**
 * `request.ip` must be the address OUR proxy vouched for, never one the client
 * wrote down.
 *
 * Every IP-keyed rate limit in this API — register, login, google — hangs off
 * `request.ip`, because `@fastify/rate-limit`'s default key generator is
 * `(req) => req.ip`. So the value of `trustProxy` is not a logging detail; it
 * decides whether those limits exist.
 *
 * `trustProxy: true` means "trust every proxy in the chain", and Fastify then
 * reports the LEFTMOST `X-Forwarded-For` entry. Caddy APPENDS the real client
 * address to that header, so with `true` the leftmost entry is whatever the
 * attacker typed: a new bucket per request, and `max: 5 / 15 minutes` on
 * register became decoration. Found 2026-07-31 by an audit, reproduced, fixed.
 *
 * This test drives real Fastify instances rather than reading the source,
 * because the failure is behavioural and the boundary is a single character.
 */
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

/** The shape production sees: Caddy's container IP on the socket, the real
 *  client appended to a header the client already put something in. */
const SPOOFED = "6.6.6.6";
const REAL_CLIENT = "203.0.113.9";
const CADDY = "172.18.0.5";

async function ipSeenBy(trustProxy: boolean | number): Promise<string> {
  const app = Fastify({ logger: false, trustProxy });
  app.get("/probe", (req) => ({ ip: req.ip }));
  try {
    const res = await app.inject({
      method: "GET",
      url: "/probe",
      remoteAddress: CADDY,
      headers: { "x-forwarded-for": `${SPOOFED}, ${REAL_CLIENT}` },
    });
    return (res.json() as { ip: string }).ip;
  } finally {
    await app.close();
  }
}

describe("trustProxy", () => {
  it("reports the address Caddy appended, not the one the client sent", async () => {
    expect(await ipSeenBy(1)).toBe(REAL_CLIENT);
  });

  it("demonstrates why `true` is wrong — it hands the client its own rate-limit key", async () => {
    // Kept as an executable explanation. If a future Fastify makes `true`
    // behave like `1`, this flips and the comment above needs revisiting; that
    // is worth being told about.
    expect(await ipSeenBy(true)).toBe(SPOOFED);
  });

  it("the app is actually built with a hop count, not `true`", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "app.ts"),
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toMatch(/trustProxy:\s*\d+/);
    expect(code).not.toMatch(/trustProxy:\s*true/);
  });
});
