import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Integration tests share one database; avoid interleaved wipes.
    fileParallelism: false,
    /**
     * 30s, not vitest's 5s default.
     *
     * Most of this directory is integration tests driving a REAL Postgres, and
     * several of them deliberately seed a limit in a sequential loop before
     * asserting the refusal that follows it — the pin cap (50 message+pin pairs),
     * the custom-emoji cap (64 inserts), the upload-url limiter (30 requests),
     * the reaction limiter (31 requests). Each of those is 30-100 round trips
     * inside ONE test body, which fits in 5s on a warm idle database and does not
     * when `pnpm -r run test` has apps/api, packages/db and apps/realtime all
     * pointed at the same instance.
     *
     * That is the entire explanation for the pin-cap test's reputation for
     * "failing only in parallel runs": the failure was always
     * `Test timed out in 5000ms`, never a wrong assertion, so the caps those
     * tests guard were never actually in doubt. Measured after the fact, the pin
     * cap test takes ~4.3s on an idle machine — it was passing with 700ms of
     * headroom, which is not a passing test, it is a coin flip.
     *
     * A hung test still fails, just 30s later; that is the right trade for a
     * suite whose honest slowest case is ~10s. Anything genuinely near this
     * budget should be split rather than have the budget raised again.
     */
    testTimeout: 30_000,
  },
});
