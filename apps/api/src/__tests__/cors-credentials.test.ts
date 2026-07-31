/**
 * CORS must never hand credentials to a reflected origin.
 *
 * Production runs `CORS_ORIGIN=*`, which registers `origin: true` — reflect
 * whatever origin asked. That is deliberate and not itself a hole: this API has
 * no cookies, sessions are Bearer tokens in the `Authorization` header, and a
 * malicious page cannot read another origin's storage to get one.
 *
 * It stops being safe the moment a cookie exists. Reflect-any plus
 * `credentials: true` means the browser attaches that cookie to requests from
 * ANY website the user visits and lets that site read the response. The
 * dangerous edit is not in this file — it is somewhere else, one `setCookie`
 * away, by someone who has no reason to think about CORS. So the two facts are
 * asserted together: if a cookie appears, this test fails and names the reason.
 *
 * Source-level on purpose. The property is "this pair of settings must not
 * drift", and the drift is a one-word change with no behavioural symptom until
 * an attacker finds it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = readFileSync(join(SRC, "app.ts"), "utf8");
/** Comments explain the bans and must not satisfy them. */
const code = APP.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("CORS credentials", () => {
  it("registers @fastify/cors with credentials disabled", () => {
    expect(code).toMatch(/register\(cors,[\s\S]{0,600}?credentials:\s*false/);
    expect(code).not.toMatch(/credentials:\s*true/);
  });

  it("still reflects any origin only when the operator asked for '*'", () => {
    // The escape hatch stays — a self-hosted operator with a fixed web origin
    // should be able to pin it. What must not happen is the wildcard becoming
    // unconditional.
    expect(code).toMatch(/corsOrigins\.includes\("\*"\)\s*\?\s*true\s*:\s*options\.env\.corsOrigins/);
  });

  it("has no cookies anywhere in the API — the premise of the above", () => {
    const cookieUse = /@fastify\/cookie|setCookie|reply\.cookie|request\.cookies|["'`]Set-Cookie/;
    // Whole-source sweep, not just app.ts: the risk arrives in a route file.
    const files = walk(SRC).filter((f) => f.endsWith(".ts") && !f.includes("__tests__"));
    const offenders = files.filter((f) => cookieUse.test(readFileSync(f, "utf8")));
    expect(
      offenders,
      "A cookie was added while CORS still reflects any origin. Pin `origin` to a " +
        "real allowlist before shipping cookie-based state.",
    ).toEqual([]);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
