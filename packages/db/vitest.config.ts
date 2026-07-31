import { defineConfig } from "vitest/config";

/**
 * These are integration tests against a REAL Postgres, and nearly every file
 * wipes and re-seeds the tables it owns. Run concurrently they interleave those
 * wipes, and the failure surfaces as a wrong row count or a missing row in
 * whichever file lost the race — which reads as a bug in the repository under
 * test and is not one.
 *
 * apps/api and apps/realtime have carried `fileParallelism: false` for exactly
 * this reason; this package was simply missed, and stayed green often enough for
 * that to look deliberate. The root `test` script also runs packages one at a
 * time (see apps/realtime/vitest.config.ts for that half of the story) — the two
 * settings together are what make this suite's green mean something.
 *
 * `testTimeout` matches apps/api: several tests drive a limit in a sequential
 * loop (dozens of round trips inside one test body), which fits in vitest's 5s
 * default on an idle machine and does not on a busy one. A test passing with
 * 700ms of headroom is a coin flip, not a pass.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
