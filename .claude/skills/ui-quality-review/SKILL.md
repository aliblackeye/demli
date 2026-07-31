---
name: ui-quality-review
description: Review renderer UI and packages/ui components for the premium dark-first design direction, required component structure, virtualization, and render performance. Use before merging any UI branch.
---

# UI Quality Review

## When to use
Any diff touching `apps/desktop/src/renderer/` or `packages/ui/src/`. Mandatory before merging Milestone 1 (Desktop UI Prototype) work.

## Inputs
- The diff, plus a running app if possible (`pnpm dev:desktop`).
- The design direction (CLAUDE.md §7) and required component list (§8).

## Procedure
1. Direction check (CLAUDE.md §7): dark-first, clean contrast, compact but readable, Linear/Raycast influence. Reject: neon gamer styling, noisy gradients, over-animation, generic admin-panel look.
2. Structure check: product UI composed from the required components (AppShell, GroupRail, ChannelSidebar, ChatView, MessageList, MessageRow, MessageComposer, MemberSidebar, VoicePanel, ScreenShareTile, ScreenShareFocusView, etc. — §8); generic primitives in `packages/ui`, product-specific composition in the renderer; Radix/shadcn as the base.
3. Performance (CLAUDE.md §27): `MessageList` virtualized (`@tanstack/react-virtual`); presence updates do not rerender the whole chat (check store selectors/memoization); speaking indicators isolated; no large blobs in React state; heavy features lazy-loaded.
4. State discipline: Zustand for UI state, TanStack Query for server state, voice state consumed from `packages/media` — no duplicated voice booleans in components.
5. Boundary check: no `ipcRenderer`, Node, or Electron imports in components — preload bridge only.
6. Error/empty/loading states exist for the touched screens; user-facing errors are friendly (CLAUDE.md §26).
7. Basics: keyboard focus visible, interactive elements are real buttons/inputs (Radix helps), text readable at compact density.
8. Run `pnpm --filter @demli/ui typecheck`, `pnpm --filter @demli/desktop typecheck`, `pnpm --filter @demli/desktop build`, `pnpm lint`; smoke via `pnpm dev:desktop` when possible.

## Checklist
- [ ] Matches dark-first premium direction, no styling drift
- [ ] Uses/extends the required §8 components; primitives live in `packages/ui`
- [ ] Long lists virtualized; no presence-driven rerender storms
- [ ] Zustand/TanStack Query/packages-media state discipline holds
- [ ] No Electron/Node access from components
- [ ] Loading/empty/error states present
- [ ] Focus and interaction basics sound
- [ ] Typecheck, lint, build pass; app renders

## Output format
Terse, in chat (CLAUDE.md §0.1): overall verdict, then only CONCERN/FAIL items with file:line (or screen) evidence. Passing items collapse to one line. A `.claude/reports/` file only if the founder asks.

## Failure conditions
FAIL if: privileged access from components, unvirtualized message list, voice state reimplemented in UI, or build/typecheck broken. Pure taste notes are CONCERNs, not blockers — but direction violations (§7 anti-goals) block.
