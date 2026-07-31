---
name: test-plan
description: Produce a concrete test plan for a feature or milestone — unit, integration, E2E smoke, and manual gates mapped to real commands. Use when starting a milestone, delegating to qa-test, or when a feature lands without coverage.
---

# Test Plan

## When to use
At milestone kickoff (what will "done" be proven by), when delegating verification to the qa-test agent, or when reviewing a branch that shipped behavior without tests.

## Inputs
- The feature/milestone scope and acceptance criteria.
- What exists: current test files (`rg --files -g '*.test.ts'`), `docs/qa/manual-checklist.md` if present.

## Procedure
1. List the behaviors that must be true, from the acceptance criteria and the CLAUDE.md §22 quality gates for the affected area (Electron / media / chat).
2. Assign each behavior the cheapest layer that can prove it:
   - **Unit** — pure logic: voice state machine transitions in `packages/media`, protocol schema validation in `packages/protocol`, query functions in `packages/db`.
   - **Integration** — API endpoints against real Postgres (`pnpm db:up`), WebSocket gateway event flow in `apps/realtime`.
   - **E2E smoke** — desktop app boots, shell renders, core click-path works.
   - **Manual** — anything needing real devices/permissions: mic capture, screen-share picker, reconnect by network drop. These go into `docs/qa/manual-checklist.md`, never silently skipped.
3. Name the exact command per item: `pnpm test`, `pnpm --filter @demli/<pkg> test`, `pnpm dev:desktop` + checklist step.
4. Define required failure-path tests, not just happy paths — for media: permission denied, device not found, track ended, reconnect failure (CLAUDE.md §11); for chat: failed optimistic send, pagination duplicates (§22).
5. Mark what is deferred and why (e.g. no E2E harness yet) — deferral is a documented decision, not an omission.
6. Add regression entries for any bug this work fixes.

## Checklist
- [ ] Every acceptance criterion mapped to a test layer and command
- [ ] Relevant §22 gate list (Electron/media/chat) fully covered
- [ ] Failure paths tested, not just happy paths
- [ ] Manual-only items written into `docs/qa/manual-checklist.md`
- [ ] Deferred coverage explicitly justified
- [ ] Regression list updated

## Output format
A table: behavior | layer (unit/integration/e2e/manual) | command or checklist ref | status (exists/to-write/deferred+reason). Plus the list of new checklist entries for `docs/qa/manual-checklist.md`.

## Failure conditions
The plan is invalid if: any acceptance criterion has no row, media/chat §22 gates are missing, commands named do not exist in any `package.json`, or "manual" is used as a euphemism for "untested" without a checklist entry.
