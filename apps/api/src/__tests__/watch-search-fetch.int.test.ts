/**
 * The DEFAULT YouTube fetch seam, over a real HTTP socket (M20 wave 2).
 *
 * Everything else about search is tested with the seam stubbed, which is right —
 * authorization, normalization, caching and the quota budget have nothing to do
 * with sockets. But a seam that is ONLY ever stubbed is a seam nobody has ever
 * run: the unfurl feature shipped a guard that passed every mocked test and then
 * failed in production because the real transport underneath behaved differently
 * (Node's `lookup` override). So the default implementation gets a local HTTP
 * server and a real request.
 *
 * What is proven here is exactly what a stub cannot prove:
 *  - the request actually goes out, carries the query we built, and comes back
 *    parsed;
 *  - a non-200 is reported as a status rather than thrown;
 *  - a body that is not JSON does not crash the client;
 *  - the request TIMES OUT instead of hanging a Fastify handler forever;
 *  - a REDIRECT is refused rather than followed — which matters because the URL
 *    carries our API key in its query string, and following a redirect would
 *    hand that key to whatever host the redirect named.
 *
 * No network egress: the server is on 127.0.0.1 and the base URL is overridden
 * per call, so this suite runs anywhere, including offline CI.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createDefaultFetchJson } from "../modules/watch/youtube.js";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

describe("watch search default fetch seam (real HTTP)", () => {
  let server: http.Server;
  let base: string;
  let handler: Handler;

  beforeAll(async () => {
    server = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("performs a real GET and returns the parsed body", async () => {
    let seenUrl = "";
    let seenAccept: string | undefined;
    handler = (req, res) => {
      seenUrl = req.url ?? "";
      seenAccept = req.headers.accept;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [{ id: { videoId: "dQw4w9WgXcQ" } }] }));
    };

    const fetchJson = createDefaultFetchJson();
    const response = await fetchJson(`${base}/youtube/v3/search?q=hello+world&key=secret`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [{ id: { videoId: "dQw4w9WgXcQ" } }] });
    // The query really crossed the wire, encoded as we built it.
    expect(seenUrl).toContain("q=hello+world");
    expect(seenAccept).toBe("application/json");
  });

  it("reports a non-200 as a status instead of throwing", async () => {
    handler = (_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "quotaExceeded" } }));
    };

    const fetchJson = createDefaultFetchJson();
    const response = await fetchJson(`${base}/youtube/v3/search?q=x`);
    // The caller decides what a 403 means; the transport just reports it.
    expect(response.status).toBe(403);
  });

  it("survives a body that is not JSON", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>not what we asked for</html>");
    };

    const fetchJson = createDefaultFetchJson();
    const response = await fetchJson(`${base}/youtube/v3/search?q=x`);
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
  });

  it("drops an oversized body rather than buffering it into the process", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ padding: "x".repeat(5_000) }));
    };

    const fetchJson = createDefaultFetchJson({ maxBytes: 1_000 });
    const response = await fetchJson(`${base}/youtube/v3/search?q=x`);
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
  });

  it("times out instead of hanging the request forever", async () => {
    handler = () => {
      // Never respond. Without the AbortController this would hold a Fastify
      // handler — and one of the API's connections — open indefinitely.
    };

    const fetchJson = createDefaultFetchJson({ timeoutMs: 250 });
    const started = Date.now();
    await expect(fetchJson(`${base}/youtube/v3/search?q=x`)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("refuses to follow a redirect, because the URL carries our API key", async () => {
    let hitSecondHop = false;
    handler = (req, res) => {
      if (req.url?.includes("/second")) {
        hitSecondHop = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(302, { location: `${base}/second` });
      res.end();
    };

    const fetchJson = createDefaultFetchJson();
    await expect(fetchJson(`${base}/youtube/v3/search?q=x&key=secret`)).rejects.toThrow();
    // The redirect target was never contacted — so the key never left with it.
    expect(hitSecondHop).toBe(false);
  });
});
