/**
 * The web build's fallback endpoints must name a domain that still resolves.
 *
 * `karagozali.com` was the pre-rebrand domain and its DNS records were deleted
 * on 2026-07-27 (CLAUDE.md §32). The vite config kept it as the default for
 * `VITE_API_URL` / `VITE_REALTIME_URL` for two days without anyone noticing,
 * because `publish-web.sh` always exports both — the live site was never wrong.
 * That is exactly what made it dangerous: the only build that would have been
 * broken is one made outside the script, and it breaks SILENTLY. The bundle
 * compiles, the page loads, the login request goes to a host that no longer
 * exists, and the user sees a generic network error.
 *
 * No runtime test can catch this — a test that actually dialled the endpoint
 * would pass today for the wrong reason (the script-built bundle is correct) and
 * would need the network. So the invariant is asserted where the value is
 * decided: in the config source.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const CONFIG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "vite.config.ts");
const source = readFileSync(CONFIG, "utf8");

/** The one public domain (CLAUDE.md §32). Anything else is a dead host. */
const LIVE_DOMAIN = "getdemli.com";

describe("web endpoint defaults", () => {
  it("falls back to the live domain, not a retired one", () => {
    expect(source).toContain(`"https://api.${LIVE_DOMAIN}"`);
    expect(source).toContain(`"wss://ws.${LIVE_DOMAIN}"`);
  });

  it("names no retired domain anywhere in the config", () => {
    // Comments explaining the history are fine; a URL is not. Match only hosts.
    const urls = source.match(/(?:https?|wss?):\/\/[a-z0-9.*-]+/gi) ?? [];
    const dead = urls.filter((u) => u.includes("karagozali"));
    expect(dead).toEqual([]);
  });

  it("still lets the environment win, so a staging build stays possible", () => {
    expect(source).toMatch(/env\.VITE_API_URL \?\?/);
    expect(source).toMatch(/env\.VITE_REALTIME_URL \?\?/);
  });
});
