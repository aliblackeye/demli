---
description: Merge a reviewed branch/worktree into dev — refuses on failing checks, security issues, unresolved architecture concerns, or dirty git state.
---

Merge the branch/worktree: $ARGUMENTS (into `dev` unless the argument says otherwise).

Run every gate. If ANY gate fails, DO NOT MERGE — output `MERGE BLOCKED` with the failing gates and the concrete fixes required, then stop.

Gates, in order:

1. **Git state clean** — `git status` on both the source branch and the merge target must show no uncommitted changes. Dirty state blocks the merge; never stash-and-hope.
2. **Review exists** — a review report for this branch in `.claude/reports/` with verdict APPROVE. No report → run `/review` first. REQUEST-CHANGES → blocked.
3. **Checks pass** — run fresh on the branch head, do not trust old results:
   - `pnpm typecheck`
   - `pnpm lint`
   - `pnpm test`
   - `pnpm build`
4. **Security** — no open BLOCKER from the security agent; if the diff touches `apps/desktop/src/main`, `src/preload`, auth, or invites and no security review exists, that is a block.
5. **Architecture** — no unresolved CONCERN/FAIL on architecture from the review.

If all gates pass:

1. `git checkout dev && git merge --no-ff <branch>` with a conventional-commit merge message (CLAUDE.md §12).
2. Re-run `pnpm typecheck` and `pnpm build` on `dev` to confirm the merge result.
3. Clean up: remove the worktree (`git worktree remove <path>`) and delete the branch if fully merged.
4. Report: what merged, checks run, follow-ups (docs update, next task).
