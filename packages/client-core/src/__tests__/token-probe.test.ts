import { describe, expect, it, vi } from "vitest";
import { probeAccountToken, type ProbeFetch } from "../account-vault/index.js";

const BASE = "https://api.example.com";

/** A fetch stub that resolves to a given status and records the call. */
function statusFetch(status: number): { fetchImpl: ProbeFetch; calls: Array<{ url: string; init?: Parameters<ProbeFetch>[1] }> } {
  const calls: Array<{ url: string; init?: Parameters<ProbeFetch>[1] }> = [];
  const fetchImpl: ProbeFetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({ status });
  };
  return { fetchImpl, calls };
}

describe("probeAccountToken", () => {
  it("returns 'valid' on 200 and hits GET /users/me with the target bearer", async () => {
    const { fetchImpl, calls } = statusFetch(200);
    const result = await probeAccountToken({ baseUrl: BASE, token: "tok_live", fetchImpl });
    expect(result).toBe("valid");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/users/me`);
    expect(calls[0]?.init?.headers?.Authorization).toBe("Bearer tok_live");
    expect(calls[0]?.init?.method).toBe("GET");
  });

  it("returns 'invalid' on 401 (dead token)", async () => {
    const { fetchImpl } = statusFetch(401);
    expect(await probeAccountToken({ baseUrl: BASE, token: "tok_dead", fetchImpl })).toBe("invalid");
  });

  it("returns 'unreachable' on an ambiguous status (5xx / 403)", async () => {
    expect(
      await probeAccountToken({ baseUrl: BASE, token: "t", fetchImpl: statusFetch(500).fetchImpl }),
    ).toBe("unreachable");
    expect(
      await probeAccountToken({ baseUrl: BASE, token: "t", fetchImpl: statusFetch(403).fetchImpl }),
    ).toBe("unreachable");
  });

  it("returns 'unreachable' when fetch rejects (network failure)", async () => {
    const fetchImpl: ProbeFetch = () => Promise.reject(new Error("network down"));
    expect(await probeAccountToken({ baseUrl: BASE, token: "t", fetchImpl })).toBe("unreachable");
  });

  it("returns 'unreachable' on timeout (aborts a never-resolving request)", async () => {
    vi.useFakeTimers();
    try {
      // A fetch that only rejects when its AbortSignal fires — i.e. a hung request
      // the probe's own timeout must abort.
      const fetchImpl: ProbeFetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      const promise = probeAccountToken({ baseUrl: BASE, token: "t", timeoutMs: 6000, fetchImpl });
      await vi.advanceTimersByTimeAsync(6000);
      expect(await promise).toBe("unreachable");
    } finally {
      vi.useRealTimers();
    }
  });
});
