# Multi-Agent Operating Model

How this project is actually run (CLAUDE.md §0–§2, §13–§14, §29–§30).

## One human, one interface

The human (founder/product owner) talks **only to the Project Director** agent.
The Director owns product and architecture decisions, plans milestones, delegates work,
reviews results, merges branches, and reports back. The human never coordinates
specialists directly.

## Specialist agents

Defined in `.claude/agents/`, one file per agent:

| Agent              | Owns                                                        |
| ------------------ | ----------------------------------------------------------- |
| product-architect  | Domain model, ADRs, scope discipline                         |
| desktop-electron   | `apps/desktop` main/preload, windows, tray, capture, updates |
| frontend-ui        | Renderer React app, `packages/ui`, design system             |
| realtime-backend   | `apps/api`, `apps/realtime`, auth, presence, rate limits     |
| media-webrtc       | LiveKit integration, voice/screen-share lifecycle            |
| database           | `packages/db`, schema, migrations, seeds                     |
| qa-test            | Test strategy, unit/integration/E2E, manual checklists       |
| devops-release     | Build scripts, docker compose, packaging, CI, releases       |
| security           | Electron security, auth review, IPC validation, secrets      |
| docs               | `docs/`, README, decision logs                               |

Each agent definition specifies: role, responsibilities, inputs/outputs, owned
files/directories, validation commands, definition of done, and escalation rules.

## Ownership rule: one agent = one branch/worktree = clearly owned files

- Parallel work is allowed **only** when file ownership is disjoint
  (e.g. one agent in `apps/desktop/src/main`, another in `packages/ui`, another in `docs/`).
- Before delegating, the Director defines: branch/worktree, owner, scope, owned files,
  acceptance criteria, validation command, handoff note.
- Two agents never edit the same file concurrently.
- Conventional commits (`feat(desktop): …`, `docs(architecture): …`); small, coherent changes;
  no uncommitted work left unreported.

## Review and merge

The **Project Director reviews and merges** every branch. Quality gates before merge —
all that apply must pass:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Plus the manual smoke checks for the touched area (see `docs/qa/manual-checklist.md`).
No merge with failing checks, unresolved security issues, architecture concerns, or a
dirty git state. If something is broken, it is reported — never hidden.
