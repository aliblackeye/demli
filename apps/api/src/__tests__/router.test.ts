/**
 * Router behaviour — the test that had to exist before find-my-way could move.
 *
 * `find-my-way` is Fastify's router. We do not depend on it directly; it came
 * along with fastify@5 and was pinned forward to >=9.7.0 by a root
 * `pnpm.overrides` entry to close GHSA-c96f-x56v-gq3h (remote DoS over HTTP/2:
 * `lookup()` indexes `this.trees[req.method]`, so an HTTP/2 `:method` of
 * `constructor` / `__proto__` / `toString` resolved an inherited Object property,
 * which the router then dereferenced as a node and crashed on).
 *
 * Forcing a router version underneath a framework is exactly the kind of change
 * that passes typecheck, passes every feature test, and quietly changes which
 * URL reaches which handler. Nothing in this suite asserted matching semantics —
 * every `expect(404)` in apps/api is an application-level "you cannot see this
 * row", produced by a handler that DID run. So this file pins the router's own
 * contract: what matches, what does not, and what an unmatched request answers.
 *
 * No database. `buildApp` is given an empty repositories object because none of
 * these requests may reach a handler that touches one — `/health` is the only
 * route driven to a 2xx, and it reads `process.uptime()`.
 */

import { connect, constants, type ClientHttp2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { Repositories } from "@demli/db";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";

const DB_URL = "postgresql://postgres:postgres@localhost:5432/demli";

describe("router — matching semantics of the real app", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      repos: {} as unknown as Repositories,
      env: loadEnv({ DATABASE_URL: DB_URL }),
      logger: false,
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it("matches a registered route", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", service: "demli-api" });
  });

  it("a query string does not participate in matching", async () => {
    const res = await app.inject({ method: "GET", url: "/health?probe=1&probe=2" });
    expect(res.statusCode).toBe(200);
  });

  it("an unknown path answers our 404 envelope, not Fastify's default", async () => {
    const res = await app.inject({ method: "GET", url: "/no-such-route" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("a known path with an unregistered method is a 404, not a 405", async () => {
    // Fastify does not synthesize 405s unless a route is declared for the path
    // with `frameworkErrors` handling; the not-found handler answers instead.
    // Pinned because a router upgrade that started emitting 405 would change
    // every client's error branch without touching a line of our code.
    const res = await app.inject({ method: "POST", url: "/health" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("matching is case sensitive", async () => {
    expect((await app.inject({ method: "GET", url: "/HEALTH" })).statusCode).toBe(404);
  });

  it("a trailing slash is a different path", async () => {
    // `ignoreTrailingSlash` is off (the Fastify default). If a future router or
    // config flipped it, `/health/` would start answering 200 and this fails —
    // which is the notification we want, not a silent behaviour change.
    expect((await app.inject({ method: "GET", url: "/health/" })).statusCode).toBe(404);
  });
});

describe("router — parametric and wildcard segments", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // A bare Fastify so the shapes under test are visible in this file rather
    // than inferred from whichever module happens to register them today.
    app = Fastify({ logger: false });
    app.get("/items/:id", async (req) => ({ hit: "param", id: (req.params as { id: string }).id }));
    app.get("/items/:id/children/:childId", async (req) => ({
      hit: "nested",
      ...(req.params as Record<string, string>),
    }));
    app.get("/static/*", async (req) => ({ hit: "wildcard", rest: (req.params as { "*": string })["*"] }));
    app.get("/items/special", async () => ({ hit: "static" }));
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("prefers a static segment over a parametric one", async () => {
    expect((await app.inject({ url: "/items/special" })).json()).toMatchObject({ hit: "static" });
  });

  it("captures a single segment into a param", async () => {
    expect((await app.inject({ url: "/items/42" })).json()).toMatchObject({ hit: "param", id: "42" });
  });

  it("a percent-encoded slash stays inside one param — it does not open a new segment", async () => {
    // The reason this matters: a param that silently split on %2F would let
    // `/items/a%2Fchildren%2Fb` reach the nested route with attacker-chosen ids.
    const res = await app.inject({ url: "/items/a%2Fchildren%2Fb" });
    expect(res.json()).toMatchObject({ hit: "param", id: "a/children/b" });
  });

  it("a param does not match across a real slash", async () => {
    expect((await app.inject({ url: "/items/1/2" })).statusCode).toBe(404);
  });

  it("matches nested params in order", async () => {
    expect((await app.inject({ url: "/items/7/children/9" })).json()).toMatchObject({
      hit: "nested",
      id: "7",
      childId: "9",
    });
  });

  it("a wildcard captures the remainder including slashes", async () => {
    expect((await app.inject({ url: "/static/a/b/c.png" })).json()).toMatchObject({
      hit: "wildcard",
      rest: "a/b/c.png",
    });
  });

  it("an EMPTY param still matches, with an empty string id", async () => {
    // Written expecting a 404, and it is a 200 — recorded because it is a real
    // footgun rather than the behaviour anyone assumes. `/items/` reaches the
    // `/items/:id` handler with `id === ""`, so any route whose handler treats a
    // falsy id as "list everything" or interpolates it into a key is reachable
    // with a bare trailing slash. Validate params; do not rely on the router.
    const res = await app.inject({ url: "/items/" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hit: "param", id: "" });
  });
});

/**
 * A real HTTP/2 server on a real socket. `app.inject()` cannot reproduce the
 * advisory: light-my-request never goes through the HTTP/2 path where an
 * arbitrary `:method` pseudo-header reaches the router untouched, and the HTTP/1
 * parser rejects these method names before Fastify sees them. The bug was only
 * reachable over h2, so the test has to be over h2.
 *
 * Its own factory because `Fastify({ http2: true })` returns a
 * `FastifyInstance<Http2Server, …>`, which is not the default `FastifyInstance`
 * — inferring the type from the factory beats spelling out four type arguments.
 */
function createHttp2App() {
  return Fastify({ logger: false, http2: true });
}

type Http2App = ReturnType<typeof createHttp2App>;

async function listenHttp2(): Promise<{ app: Http2App; origin: string }> {
  const app = createHttp2App();
  app.get("/health", async () => ({ status: "ok" }));
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return { app, origin: `http://127.0.0.1:${port}` };
}

describe("router — GHSA-c96f-x56v-gq3h (HTTP/2 method prototype lookup)", () => {
  let app: Http2App;
  let session: ClientHttp2Session;

  beforeAll(async () => {
    const started = await listenHttp2();
    app = started.app;
    session = connect(started.origin);
    await new Promise<void>((resolve, reject) => {
      session.once("connect", () => resolve());
      session.once("error", reject);
    });
  });

  afterAll(async () => {
    session?.close();
    await app?.close();
  });

  /** Sends one h2 request with an arbitrary `:method` and resolves its status. */
  function request(method: string, path: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const stream = session.request({
        [constants.HTTP2_HEADER_METHOD]: method,
        [constants.HTTP2_HEADER_PATH]: path,
      });
      stream.on("response", (headers) => {
        resolve(Number(headers[constants.HTTP2_HEADER_STATUS]));
        stream.resume();
      });
      stream.on("error", reject);
      stream.end();
    });
  }

  it("serves a normal h2 request (the control)", async () => {
    expect(await request("GET", "/health")).toBe(200);
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])(
    "answers instead of crashing when :method is %s",
    async (method) => {
      // On find-my-way <9.7.0 the first of these took the process down with
      // `Cannot read properties of undefined (reading 'length')` — one
      // unauthenticated frame per worker. Any status is a pass here; being
      // alive is the assertion.
      const status = await request(method, "/health");
      expect(status).toBeGreaterThanOrEqual(400);
    },
  );

  it("is still serving after the malformed methods", async () => {
    expect(await request("GET", "/health")).toBe(200);
  });
});
