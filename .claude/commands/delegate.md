---
description: Assign a scoped task to one or more specialist agents with branch, file ownership, and acceptance criteria.
---

Delegate this work: $ARGUMENTS

1. Pick the owner(s) from `.claude/agents/` whose ownership matches the touched files. One agent per branch/worktree (CLAUDE.md §12, §30).
2. Define the task brief BEFORE launching any agent: branch/worktree, owner, scope, files owned, acceptance criteria, validation command, handoff note requirement. Use the `git-worktree-orchestration` skill when tasks run in parallel.
3. For parallel tasks, verify zero file-ownership overlap. If two tasks need the same file, serialize them or split the file ownership explicitly.
4. Launch each agent (Task tool with the matching subagent) with its full brief. Require the agent to file a handoff note in `.claude/reports/` and to run its validation commands before reporting done.
5. Do not let agents wander: no work outside the listed files without escalating back.

Report each delegation in exactly this format:

```
Task
Owner
Branch/worktree
Files owned
Acceptance criteria
Validation commands
Deadline/order
```
