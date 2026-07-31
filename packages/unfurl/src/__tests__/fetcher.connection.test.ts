import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultOpenConnection } from "../fetcher.js";

/**
 * Real-socket regression test for the IP-pinning `lookup` shim (M17 hotfix).
 *
 * On Node ≥20, `net.connect` has autoSelectFamily enabled by default and calls
 * the custom lookup with `all: true`, expecting an ARRAY of {address, family}.
 * The original shim always answered with the legacy string form, so EVERY real
 * connection threw "Invalid IP address: undefined" — while the guarded-fetcher
 * unit tests stayed green because they mock the openConnection seam entirely.
 * This test drives a genuine socket against a local server so the lookup shim
 * runs under the real Node contract, whatever it is on the current runtime.
 */
describe("defaultOpenConnection (real socket)", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><head><title>pin-ok</title></head><body>hello</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("connects via the pinned IP with a hostname URL (autoSelectFamily lookup contract)", async () => {
    // Hostname (not IP literal) in the URL forces the custom lookup to run;
    // the pinned IP — not DNS — must decide where the socket goes.
    const url = new URL(`http://localhost:${port}/`);
    const response = await defaultOpenConnection({
      url,
      pinnedIp: "127.0.0.1",
      headers: { "User-Agent": "test", Accept: "text/html" },
      timeoutMs: 5000,
      maxBytes: 64 * 1024,
    });
    expect(response.status).toBe(200);
    expect(response.body).toContain("pin-ok");
  });
});
