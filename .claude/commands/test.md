---
description: Run the full validation suite — typecheck, lint, unit/integration tests, build, and the desktop smoke path.
---

Run all available validation and report results honestly — a failure is a finding, not something to retry into silence.

Run in this order (continue through failures, collect all results):

1. `pnpm typecheck`
2. `pnpm lint`
3. `pnpm test` (unit + integration; note any package with no `test` script yet)
4. `pnpm build`
5. Desktop smoke where possible: `pnpm dev:desktop` — app opens, no main/preload error, no renderer console crash, basic navigation works (CLAUDE.md §22). If the environment cannot run the GUI, say so and point to `docs/qa/manual-checklist.md` instead of pretending it passed.
6. If media or chat code changed, list the relevant manual gates from CLAUDE.md §22 that still need a human run.

Report as a table: step | command | PASS/FAIL/SKIPPED | evidence (exact error for failures). End with a single verdict line: GREEN, or RED with the shortest path to green.
