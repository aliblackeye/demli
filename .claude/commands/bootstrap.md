---
description: Set up or repair the project operating system — repo structure, workspace config, commands, skills, agents, docs, and the bootstrap commit.
---

Bootstrap the Demli project operating system per CLAUDE.md §2 and §32. This command is idempotent: verify before creating, never overwrite existing work.

1. Inspect: `git status`, `node -v`, `pnpm -v`, `ls`. Initialize git (`git init`, branch `main`, then `dev`) only if missing.
2. Verify workspace files exist: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`, `.gitignore`, `.env.example`, `docker-compose.yml`. Create only what is missing.
3. Verify the monorepo skeleton (CLAUDE.md §4): `apps/desktop` (src/main, src/preload, src/renderer), `apps/api/src/modules/`, `apps/realtime/src`, `apps/web` (placeholder ok), `packages/{ui,config,types,protocol,db,media}`, `scripts/`.
4. Verify `.claude/` operational files: `agents/` (10 agents), `commands/` (12 commands), `skills/` (8 skills), `reports/README.md`.
5. Verify docs skeleton (CLAUDE.md §20): `docs/{product,architecture,decisions,agents,qa}/` with the listed starter files; create missing ones as short stubs, never filler.
6. Run `pnpm install`, then `pnpm typecheck` and `pnpm lint` to confirm the workspace is healthy.
7. Commit if there are changes: `git add . && git commit -m "chore(repo): bootstrap project operating system"`.

Then report in exactly this format:

```
What was created
What was skipped
What needs human decision
Next command to run
```
