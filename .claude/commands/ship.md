---
description: Prepare a milestone release — changelog, known issues, build artifacts, manual QA checklist, release notes.
---

Prepare a milestone release. Do not ship anything that `/test` would block.

1. **Gate**: run the `/test` suite (`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`). RED means stop and report.
2. **Release check**: apply the `release-check` skill.
3. **Changelog**: generate from conventional commits — `git log <last-tag-or-milestone>..HEAD --oneline` — grouped by feat/fix/chore/docs/test.
4. **Known issues**: collect open items from `.claude/reports/` and the regression list in `docs/qa/`; list them honestly.
5. **Build artifacts**: `pnpm build`; for a desktop release run `pnpm package:win` (if still the Milestone 5 stub, state that the installer is deferred and what ships instead, e.g. dev-mode run instructions).
6. **Manual QA checklist**: run or delegate `docs/qa/manual-checklist.md` (Electron, media, and chat gates from CLAUDE.md §22); record results.
7. **Release notes**: short, human-readable — what's new, what's known-broken, how to run it.
8. Tag: `git tag -a v<version> -m "<milestone>"` after everything above is green and the human approves the ship.

Output:

```
changelog
known issues
build artifacts
manual QA checklist
release notes
```
