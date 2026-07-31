---
description: Report current project state — done, in progress, blocked, risks, git cleanliness, next actions.
---

Produce a project status report. Gather facts first, then report — never guess.

1. `git status` (note anything uncommitted), `git branch -a`, `git worktree list`, `git log --oneline -10`.
2. Scan `.claude/reports/` for recent handoff/review notes and open items.
3. Check the current milestone plan (`docs/product/plan-*.md` or CLAUDE.md §31) and compare against what exists in the repo.
4. If cheap to run, verify health: `pnpm typecheck` and `pnpm lint`.

Report in exactly this format (CLAUDE.md §34 — keep it short, say clearly if something broke):

```
Done
In progress
Blocked
Risks
Dirty git state
Next actions
```
