---
name: git-worktree-orchestration
description: Set up and manage parallel agent work via git branches/worktrees with clean file ownership. Use when delegating 2+ tasks in parallel, before spawning agents, and when cleaning up after merges.
---

# Git Worktree Orchestration

## When to use
Whenever `/delegate` assigns parallel tasks, before spawning any implementing agent, and after `/merge` to clean up. Also to untangle a dirty multi-branch state.

## Inputs
- The task list with intended owners and the files each task touches.
- Current state: `git status`, `git branch -a`, `git worktree list`.

## Procedure
1. Verify the base is clean: `git status` on `dev` shows nothing uncommitted. Dirty base → stop, resolve first (commit, or report per CLAUDE.md §12 — never leave uncommitted work unreported).
2. Write the ownership manifest BEFORE creating anything: per task — owner agent, branch name, worktree path, owned files/directories, acceptance criteria, validation command, handoff note location (CLAUDE.md §30).
3. Check for overlap: no file/directory appears under two owners. Overlap → serialize the tasks or split ownership at a finer path. Shared files (`packages/types`, `packages/protocol`, root `package.json`) get ONE owner per cycle; everyone else requests changes through them.
4. Create one worktree per parallel agent, branched from `dev`, named `feat/<scope>` — e.g.:
   - `git worktree add ../demli-desktop-shell -b feat/desktop-shell dev`
   - `git worktree add ../demli-ui-system -b feat/ui-system dev`
   - `git worktree add ../demli-backend-core -b feat/backend-core dev`
   - `git worktree add ../demli-media-livekit -b feat/media-livekit dev`
   (Sequential single tasks can use a plain branch instead of a worktree.)
5. Hand each agent its worktree path and manifest entry. Agents commit small, coherent, conventional commits (`feat(desktop): ...`, `fix(media): ...` — CLAUDE.md §12) and never touch files outside their ownership.
6. Define merge order up front when tasks depend on each other (e.g. protocol changes merge before consumers).
7. After `/merge`: `git worktree remove <path>`, delete the merged branch, re-run `git worktree list` to confirm cleanup.

## Checklist
- [ ] Base branch clean before creating worktrees
- [ ] Ownership manifest written, zero file overlap between parallel owners
- [ ] One agent = one branch/worktree, branched from `dev`
- [ ] Shared packages have a single designated owner this cycle
- [ ] Conventional commit format communicated
- [ ] Merge order defined for dependent tasks
- [ ] Worktrees/branches cleaned up after merge

## Output format
The ownership manifest as a table (task | owner | branch | worktree path | owned files | validation command | merge order), plus the exact `git worktree add` commands run.

## Failure conditions
Stop and report to the Project Director if: two tasks genuinely need the same files (spec problem, not a git problem), the base branch is dirty and the owner of the changes is unknown, or a worktree has uncommitted work whose branch is about to be deleted.
