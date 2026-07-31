---
name: architecture-review
description: Review a change or design against Demli's architecture rules — package boundaries, domain type placement, event typing, Electron/media separation. Use before merging any branch that adds modules, crosses package boundaries, or changes structure.
---

# Architecture Review

## When to use
Before `/merge` of any branch that: creates new files/modules, imports across package boundaries, touches `packages/types` or `packages/protocol`, or changes how apps talk to each other. Also for design proposals before implementation.

## Inputs
- The diff (`git diff dev...HEAD`) or the design doc.
- The current milestone scope (CLAUDE.md §31) — to catch scope creep, not just structure damage.

## Procedure
1. Map every new/changed file to its owning location. Domain types must live in `packages/types`; event contracts in `packages/protocol`; UI primitives in `packages/ui` (CLAUDE.md §23).
2. Check dependency direction: apps depend on packages, never the reverse; no `apps/api` importing from `apps/desktop`, etc.
3. Grep the diff for magic-string realtime events (quoted `message.`, `typing.`, `presence.`, `voice.`, `screen.` strings outside `packages/protocol`).
4. Check Electron separation: no `ipcRenderer`/Node APIs inside React components; renderer talks only to the preload bridge.
5. Check media separation: voice/screen lifecycle logic lives in `packages/media`, not in chat UI components.
6. Scan for giant files (rough gate: >400 lines of new code in one file needs justification) and undocumented "temporary" hacks.
7. Check MVP scope: Owner/Member/Guest only, no speculative abstractions for features from the "later" list (CLAUDE.md §5, §6).
8. Verify `pnpm typecheck` passes.

## Checklist
- [ ] Domain types in `packages/types`, events in `packages/protocol`, UI primitives in `packages/ui`
- [ ] No app-to-app imports; dependency direction apps → packages only
- [ ] No magic-string event names outside `packages/protocol`
- [ ] No Electron privileged logic in React components
- [ ] Media lifecycle separate from chat UI
- [ ] No giant files or undocumented hacks
- [ ] No overengineering beyond current milestone scope
- [ ] `pnpm typecheck` passes

## Output format
Terse, in chat (CLAUDE.md §0.1): one verdict line, then ONLY the non-PASS items (file:line + concrete fix). Collapse everything that passed into a single line. Write a `.claude/reports/` file only if the founder asks.

## Failure conditions
FAIL (blocks merge) if: types/events duplicated outside their home package, app-to-app import exists, untyped realtime event introduced, privileged Electron code sits in a component, or typecheck fails. CONCERNs must be either fixed or explicitly accepted by the Project Director in writing.
