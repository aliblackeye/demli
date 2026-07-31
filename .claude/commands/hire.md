---
description: Create or update a specialist agent definition in .claude/agents/ for a named role or capability gap.
---

Hire (create or update) a specialist agent for: $ARGUMENTS

1. Check `.claude/agents/` first. If an existing agent already covers this capability, update that file instead of creating a near-duplicate.
2. Match the role against the hiring model in CLAUDE.md §13 before inventing a new one.
3. Write/update `.claude/agents/<kebab-case-name>.md` with YAML frontmatter (`name`, `description` — the description must state when the Project Director should delegate to it) and body sections: Role, Responsibilities, Files/directories owned, Inputs expected, Outputs expected, Validation commands, Definition of done, Escalation rules.
4. Owned files must map to real repo paths (`apps/desktop`, `apps/api`, `apps/realtime`, `packages/*`, `docs/`) and must not overlap another agent's ownership — resolve overlaps explicitly in both files.
5. Validation commands must be real: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, or `pnpm --filter @demli/<pkg> <script>`.

Then report in exactly this format:

```
Agent role
Responsibilities
Owned files
First task
Definition of done
```
