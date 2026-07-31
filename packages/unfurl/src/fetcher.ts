/**
 * SSRF-guarded page fetcher (M17, CLAUDE.md §28). Fetches a URL's HTML for
 * unfurling while defending against SSRF at every step:
 *
 *  (a) only `http:` / `https:` are allowed;
 *  (b) the hostname is resolved and EVERY resolved IP is checked against
 *      {@link isBlockedAddress} BEFORE connecting; the connection is then PINNED
 *      to the validated IP (`lookup` override) so a second DNS answer cannot
 *      rebind us to a private host (TOCTOU);
 *  (c) redirects are followed MANUALLY (never by the HTTP client), re-running the
 *      full guard on each hop, capped at {@link UNFURL_MAX_REDIRECTS};
 *  (d) a request timeout, a response byte cap, and a `text/html` content-type
 *      gate bound the work and the payload.
 *
 * Two seams — `resolveHost` (DNS) and `openConnection` (the single HTTP GET) —
 * are injectable so the guard logic is unit-testable with no real network. The
 * defaults use `node:dns`/`node:http(s)`.
 */

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import {
  UNFURL_FETCH_TIMEOUT_MS,
  UNFURL_MAX_REDIRECTS,
  UNFURL_MAX_RESPONSE_BYTES,
  UNFURL_USER_AGENT,
} from "./constants.js";
import { isBlockedAddress } from "./ssrf.js";

/** The HTML of a successfully fetched, safe, `text/html` page. */
export interface FetchedPage {
  /** The final URL after redirects (used as the base for relative og:image). */
  finalUrl: string;
  html: string;
}

/** One raw HTTP response, after the client read+capped the body. */
export interface RawHttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** Body (truncated to the byte cap); "" for non-HTML, redirects, or errors. */
  body: string;
}

export interface OpenConnectionInput {
  url: URL;
  /** The pre-validated IP the socket MUST connect to (DNS-rebinding defense). */
  pinnedIp: string;
  headers: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
}

export interface GuardedFetcherDeps {
  /** Resolve a hostname to one or more IP strings. Default: `dns.lookup(all)`. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  /** Perform ONE HTTP GET pinned to `pinnedIp`. Default: `node:http(s)`. */
  openConnection?: (input: OpenConnectionInput) => Promise<RawHttpResponse>;
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  log?: (message: string) => void;
}

export type GuardedFetcher = (rawUrl: string) => Promise<FetchedPage | null>;

/** First header value (arrays flatten to their first entry). */
function headerValue(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

const HTML_CONTENT_TYPE = /text\/html|application\/xhtml\+xml/i;

/** Default DNS resolution: all addresses (v4 + v6), so we validate every one. */
function defaultResolveHost(hostname: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => a.address));
    });
  });
}

/**
 * Default single HTTP GET: pinned IP, timeout, byte cap, no auto-redirect.
 * Exported for the real-socket regression test — the IP-pinning `lookup` shim
 * must satisfy Node ≥20's autoSelectFamily (`all: true`) contract, which only a
 * genuine connection exercises (the guard tests mock this seam away).
 */
export function defaultOpenConnection(input: OpenConnectionInput): Promise<RawHttpResponse> {
  const { url, pinnedIp, headers, timeoutMs, maxBytes } = input;
  const isHttps = url.protocol === "https:";
  const client = isHttps ? https : http;

  return new Promise<RawHttpResponse>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const request = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { ...headers, Host: url.host },
        timeout: timeoutMs,
        // Pin the socket to the validated IP so no fresh DNS answer can rebind
        // us to a private address between the guard and the connect (TOCTOU).
        // Node ≥20 (autoSelectFamily) calls lookup with `all: true` and expects
        // an ARRAY of {address, family}; answering with the legacy string form
        // there makes net throw "Invalid IP address: undefined" — which killed
        // every real https unfurl while the mocked-seam tests stayed green.
        lookup: (_hostname, options, callback) => {
          const family = net.isIPv6(pinnedIp) ? 6 : 4;
          if (options.all) {
            (callback as unknown as (
              err: Error | null,
              addresses: Array<{ address: string; family: number }>,
            ) => void)(null, [{ address: pinnedIp, family }]);
          } else {
            callback(null, pinnedIp, family);
          }
        },
        // TLS SNI/cert validation still targets the real hostname.
        ...(isHttps ? { servername: url.hostname } : {}),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const contentType = String(response.headers["content-type"] ?? "");

        // Redirects and non-HTML/non-200 responses: drain, don't read a body.
        if (
          (status >= 300 && status < 400) ||
          status !== 200 ||
          !HTML_CONTENT_TYPE.test(contentType)
        ) {
          response.resume();
          response.on("end", () =>
            done(() => resolve({ status, headers: response.headers, body: "" })),
          );
          response.on("error", (err) => done(() => reject(err)));
          return;
        }

        let received = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          if (received < maxBytes) {
            const remaining = maxBytes - received;
            chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
          }
          received += chunk.length;
          if (received >= maxBytes) {
            request.destroy();
            done(() =>
              resolve({
                status,
                headers: response.headers,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          }
        });
        response.on("end", () =>
          done(() =>
            resolve({
              status,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          ),
        );
        response.on("error", (err) => done(() => reject(err)));
      },
    );

    request.on("timeout", () => request.destroy(new Error("unfurl request timed out")));
    request.on("error", (err) => done(() => reject(err)));
    request.end();
  });
}

/**
 * Build a guarded fetcher. Returns `fetchPage(url)` → the page HTML, or `null`
 * for any unsafe / non-HTML / failed fetch (never throws).
 */
export function createGuardedFetcher(deps: GuardedFetcherDeps = {}): GuardedFetcher {
  const resolveHost = deps.resolveHost ?? defaultResolveHost;
  const openConnection = deps.openConnection ?? defaultOpenConnection;
  const maxRedirects = deps.maxRedirects ?? UNFURL_MAX_REDIRECTS;
  const timeoutMs = deps.timeoutMs ?? UNFURL_FETCH_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? UNFURL_MAX_RESPONSE_BYTES;
  const userAgent = deps.userAgent ?? UNFURL_USER_AGENT;
  const log = deps.log ?? ((): void => undefined);

  return async function fetchPage(rawUrl: string): Promise<FetchedPage | null> {
    let current: URL;
    try {
      current = new URL(rawUrl);
    } catch {
      return null;
    }

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (current.protocol !== "http:" && current.protocol !== "https:") {
        log(`unfurl: rejected non-http(s) protocol '${current.protocol}'`);
        return null;
      }

      let addresses: string[];
      try {
        addresses = await resolveHost(current.hostname);
      } catch (err) {
        log(`unfurl: DNS resolution failed for ${current.hostname}: ${errText(err)}`);
        return null;
      }
      if (addresses.length === 0) {
        log(`unfurl: no addresses for ${current.hostname}`);
        return null;
      }
      for (const address of addresses) {
        if (isBlockedAddress(address)) {
          log(`unfurl: blocked address ${address} for ${current.hostname}`);
          return null;
        }
      }
      const pinnedIp = addresses[0];
      if (!pinnedIp) return null;

      let response: RawHttpResponse;
      try {
        response = await openConnection({
          url: current,
          pinnedIp,
          headers: { "User-Agent": userAgent, Accept: "text/html,application/xhtml+xml" },
          timeoutMs,
          maxBytes,
        });
      } catch (err) {
        log(`unfurl: fetch failed for ${current.toString()}: ${errText(err)}`);
        return null;
      }

      // Manual redirect handling: re-validate the next hop from the loop top.
      if (response.status >= 300 && response.status < 400) {
        const location = headerValue(response.headers["location"]);
        if (!location) {
          log(`unfurl: ${response.status} with no Location for ${current.toString()}`);
          return null;
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          log(`unfurl: bad redirect target '${location}'`);
          return null;
        }
        current = next;
        continue;
      }

      if (response.status !== 200) {
        log(`unfurl: non-200 status ${response.status} for ${current.toString()}`);
        return null;
      }
      const contentType = headerValue(response.headers["content-type"]) ?? "";
      if (!HTML_CONTENT_TYPE.test(contentType)) {
        log(`unfurl: non-HTML content-type '${contentType}' for ${current.toString()}`);
        return null;
      }
      return { finalUrl: current.toString(), html: response.body };
    }

    log(`unfurl: too many redirects for ${rawUrl}`);
    return null;
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
