---
description: Create a milestone plan with scope, tasks, owners, dependencies, validation, and risks.
---

Create a milestone plan for: $ARGUMENTS

If no argument is given, plan the next milestone from CLAUDE.md §31 (Milestone 0 Bootstrap → 1 Desktop UI Prototype → 2 Backend + Realtime Chat → 3 Voice MVP → 4 Screen Share MVP → 5 Product Hardening) based on current repo state.

Rules:
- Scope stays inside the milestone. Anything else goes under Non-goals.
- Every task gets exactly one owner from `.claude/agents/` (product-architect, desktop-electron, frontend-ui, realtime-backend, media-webrtc, database, qa-test, devops-release, security, docs).
- Parallel tasks must have non-overlapping file ownership (CLAUDE.md §30). Flag any overlap as a dependency instead.
- Validation must name real commands: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm --filter @demli/desktop build`, plus the manual gates from CLAUDE.md §22.

Output in exactly this format:

```
Milestone
Scope
Non-goals
Tasks
Owners
Dependencies
Validation
Risks
```

Save the accepted plan to `docs/product/plan-<milestone-slug>.md` so future sessions can resume it.
