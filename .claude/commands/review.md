---
description: Review a branch/worktree across architecture, type safety, security, tests, UX, performance, maintainability, and git cleanliness.
---

Review the branch/worktree: $ARGUMENTS (default: the current branch, diffed against `dev`).

1. `git status` and `git diff dev...HEAD --stat` to scope the change; read the full diff of touched files.
2. Apply the matching skills based on touched paths:
   - any structural change → `architecture-review`
   - `apps/desktop/src/main` or `src/preload` → `electron-security-review`
   - `packages/protocol`, `apps/realtime` → `realtime-event-design`
   - `packages/media` → `webrtc-media-review`
   - `apps/desktop/src/renderer`, `packages/ui` → `ui-quality-review`
3. Run checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` (or the affected `pnpm --filter @demli/<pkg>` equivalents).
4. Check every dimension and give each a verdict (PASS / CONCERN / FAIL) with file:line evidence:

```
Architecture
Type safety
Security
Tests
UX
Performance
Maintainability
Git cleanliness
```

5. Write the review to `.claude/reports/review-<branch>-<yyyy-mm-dd>.md` with an overall verdict: APPROVE or REQUEST-CHANGES (with a concrete fix list). `/merge` will read this report.

Never approve with failing checks or unread diff sections.
