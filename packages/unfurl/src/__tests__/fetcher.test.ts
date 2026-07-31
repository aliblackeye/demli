/**
 * Guarded-fetcher SSRF orchestration tests (M17, CLAUDE.md §28). The DNS and
 * HTTP seams are injected so the guard logic — protocol gate, resolve+validate
 * BEFORE connect, IP pinning, and redirect RE-validation — is exercised with no
 * real network (the brief's "mock the fetch"). {@link isBlockedAddress} itself is
 * unit-tested separately; here we assert the fetcher HONORS it at every hop.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createGuardedFetcher,
  type OpenConnectionInput,
  type RawHttpResponse,
} from "../fetcher.js";

const HTML_OK: RawHttpResponse = {
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
  body: "<html><head><meta property='og:title' content='ok'></head></html>",
};

function redirectTo(location: string): RawHttpResponse {
  return { status: 302, headers: { location }, body: "" };
}

describe("createGuardedFetcher — SSRF guard", () => {
  it("BLOCKS the cloud-metadata endpoint before connecting", async () => {
    const openConnection = vi.fn<(i: OpenConnectionInput) => Promise<RawHttpResponse>>();
    const fetchPage = createGuardedFetcher({
      resolveHost: async () => ["169.254.169.254"],
      openConnection,
    });
    expect(await fetchPage("http://metadata.internal/latest")).toBeNull();
    expect(openConnection).not.toHaveBeenCalled();
  });

  it("BLOCKS a host that resolves to a private address", async () => {
    const openConnection = vi.fn<(i: OpenConnectionInput) => Promise<RawHttpResponse>>();
    const fetchPage = createGuardedFetcher({
      resolveHost: async () => ["10.0.0.5"],
      openConnection,
    });
    expect(await fetchPage("http://intranet.example/")).toBeNull();
    expect(openConnection).not.toHaveBeenCalled();
  });

  it("BLOCKS when ANY resolved address is private (mixed answer)", async () => {
    const openConnection = vi.fn<(i: OpenConnectionInput) => Promise<RawHttpResponse>>();
    const fetchPage = createGuardedFetcher({
      resolveHost: async () => ["93.184.216.34", "10.0.0.1"],
      openConnection,
    });
    expect(await fetchPage("http://evil.example/")).toBeNull();
    expect(openConnection).not.toHaveBeenCalled();
  });

  it("BLOCKS a redirect that lands on a private address (re-validated per hop)", async () => {
    const resolveHost = vi.fn(async (hostname: string) =>
      hostname === "public.example" ? ["93.184.216.34"] : ["10.0.0.5"],
    );
    const openConnection = vi.fn(async () => redirectTo("http://internal.example/secret"));
    const fetchPage = createGuardedFetcher({ resolveHost, openConnection });

    expect(await fetchPage("http://public.example/start")).toBeNull();
    // Connected once (the public first hop); the private redirect target was
    // rejected at the DNS-validation stage, never connected.
    expect(openConnection).toHaveBeenCalledTimes(1);
    expect(resolveHost).toHaveBeenCalledWith("internal.example");
  });

  it("REJECTS a non-http(s) protocol without resolving", async () => {
    const resolveHost = vi.fn<(h: string) => Promise<string[]>>();
    const fetchPage = createGuardedFetcher({
      resolveHost,
      openConnection: async () => HTML_OK,
    });
    expect(await fetchPage("ftp://example.com/file")).toBeNull();
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("pins the connection to the validated IP", async () => {
    const openConnection = vi.fn(async (input: OpenConnectionInput) => {
      expect(input.pinnedIp).toBe("93.184.216.34");
      return HTML_OK;
    });
    const fetchPage = createGuardedFetcher({
      resolveHost: async () => ["93.184.216.34"],
      openConnection,
    });
    const page = await fetchPage("https://example.com/p");
    expect(page?.finalUrl).toBe("https://example.com/p");
    expect(page?.html).toContain("og:title");
  });

  it("follows a safe redirect and returns the final page", async () => {
    const resolveHost = async () => ["93.184.216.34"];
    const openConnection = vi
      .fn<(i: OpenConnectionInput) => Promise<RawHttpResponse>>()
      .mockResolvedValueOnce(redirectTo("https://example.com/final"))
      .mockResolvedValueOnce(HTML_OK);
    const fetchPage = createGuardedFetcher({ resolveHost, openConnection });

    const page = await fetchPage("https://example.com/start");
    expect(page?.finalUrl).toBe("https://example.com/final");
    expect(openConnection).toHaveBeenCalledTimes(2);
  });

  it("gives up after too many redirects", async () => {
    const fetchPage = createGuardedFetcher({
      resolveHost: async () => ["93.184.216.34"],
      openConnection: async () => redirectTo("https://example.com/again"),
      maxRedirects: 3,
    });
    expect(await fetchPage("https://example.com/loop")).toBeNull();
  });

  it("rejects a non-HTML content-type", async () => {
    const fetchPage = createGuardedFetcher({
      resolveHost: async () => ["93.184.216.34"],
      openConnection: async () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    });
    expect(await fetchPage("https://example.com/api")).toBeNull();
  });

  it("rejects a non-200 status", async () => {
    const fetchPage = createGuardedFetcher({
      resolveHost: async () => ["93.184.216.34"],
      openConnection: async () => ({ status: 404, headers: {}, body: "" }),
    });
    expect(await fetchPage("https://example.com/missing")).toBeNull();
  });

  it("returns null (never throws) when the connection errors", async () => {
    const fetchPage = createGuardedFetcher({
      resolveHost: async () => ["93.184.216.34"],
      openConnection: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(await fetchPage("https://example.com/down")).toBeNull();
  });

  it("returns null when DNS resolution fails", async () => {
    const fetchPage = createGuardedFetcher({
      resolveHost: async () => {
        throw new Error("ENOTFOUND");
      },
      openConnection: async () => HTML_OK,
    });
    expect(await fetchPage("https://nope.invalid/")).toBeNull();
  });
});
