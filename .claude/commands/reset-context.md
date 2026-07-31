---
description: Persist the current project state into durable docs so a fresh session can resume without re-discovery.
---

Snapshot everything a future session needs into durable files. Assume the next session starts with zero memory of this one.

1. Gather facts: `git status`, `git branch -a`, `git worktree list`, `git log --oneline -15`, newest notes in `.claude/reports/`.
2. Write/update `docs/project-state.md` with:
   - Current milestone and % feel (honest, not optimistic)
   - Done / In progress / Blocked (per CLAUDE.md §34)
   - Active branches/worktrees and their owners
   - Open decisions awaiting the human (CLAUDE.md §33 items)
   - Next 3 actions, in order
3. Verify decisions made this session are captured as ADRs in `docs/decisions/` — create missing ones via the `/adr` flow.
4. Verify unfinished agent work has a handoff note in `.claude/reports/` (branch, state, what remains, validation status). Uncommitted work must be either committed to its feature branch or explicitly documented — never silently abandoned (CLAUDE.md §12).
5. Update `docs/product/plan-*.md` task states if a milestone plan exists.
6. Commit the doc updates: `docs(state): snapshot project context`.

Then report: which files were written, and the single next command a fresh session should run (usually `/director`).
