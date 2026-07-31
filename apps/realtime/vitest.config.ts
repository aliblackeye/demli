import { defineConfig } from "vitest/config";

/**
 * `fileParallelism: false` keeps THIS package's integration tests from interleaving
 * on the shared Postgres — but it says nothing about the other packages, and that
 * gap has now cost us twice.
 *
 * apps/api, packages/db and apps/realtime all point at the SAME database, and the
 * root `test` script used to run them concurrently. Two failures came out of that,
 * both of which read as bugs in the code under test and were neither:
 *
 *  - `apps/api` pin-cap tests timing out (100 sequential round trips racing three
 *    suites for the same instance — fixed there by raising `testTimeout`).
 *  - `gateway.dm-call-disconnect` seeing a LIVE ring flip to `missed`, because the
 *    dm-call sweeper's suite legitimately fast-forwards an injected clock and its
 *    sweep is global over the table — so it reaped a row this suite owned.
 *
 * The root script therefore runs packages one at a time
 * (`pnpm -r --workspace-concurrency=1 run test`). Do not "speed the suite back up"
 * by removing that without giving each package its own database first.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
  },
});
