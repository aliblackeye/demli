---
name: release-check
description: Pre-release gate — verify checks, security, docs, env hygiene, artifacts, and manual QA before shipping a milestone. Use inside /ship or whenever a build is about to reach the human.
---

# Release Check

## When to use
Before any `/ship`, milestone demo, or build handed to the human. This is the last gate — nothing here is optional.

## Inputs
- Target milestone and its scope (CLAUDE.md §31).
- Latest reports in `.claude/reports/` (reviews, security verdicts, QA runs).

## Procedure
1. Green suite, run fresh: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`. Any failure stops the release.
2. Git hygiene: `git status` clean on `dev`; no orphaned worktrees with uncommitted work (`git worktree list`); all milestone branches merged or explicitly excluded.
3. Security: latest security review verdict is PASS with no open BLOCKER; `electron-security-review` run if any main/preload change shipped this milestone.
4. Secrets sweep: no real secrets in the tree (`rg -i 'api[_-]?key|secret|password' --glob '!*.example' --glob '!node_modules'` over config/env files); `.env.example` files match the vars the code actually reads (CLAUDE.md §18).
5. Manual QA: `docs/qa/manual-checklist.md` executed for the affected areas — Electron opens clean, media gates (join/mute/leave/reconnect/screen-share), chat gates (send/receive/persist/pagination) per CLAUDE.md §22. Record who ran it and results.
6. Artifacts: `pnpm build` output present; for desktop releases `pnpm package:win` (if still the Milestone 5 stub, record "installer deferred" as a known issue with run-from-dev instructions).
7. Docs current: README run instructions true; ADRs exist for this milestone's decisions; changelog generated from conventional commits.
8. Known issues list written — honest, from open report items and the regression list. An empty known-issues list on a young product is a red flag, not an achievement.

## Checklist
- [ ] typecheck / lint / test / build all green, run fresh
- [ ] Git clean, no stray worktrees or unmerged milestone branches
- [ ] Security verdict PASS, no open BLOCKERs
- [ ] No secrets committed; `.env.example` complete
- [ ] Manual QA checklist executed and recorded
- [ ] Artifacts built (or installer deferral documented)
- [ ] README/ADRs/changelog current
- [ ] Known issues list written honestly

## Output format
Terse, in chat (CLAUDE.md §0.1): the verdict `SHIP` / `NO-SHIP (reasons)` first, then only failing/N-A items with evidence, plus known issues and artifact locations. Passing checks collapse to one line. This is the one skill where filing `.claude/reports/` IS worth it — keep the release bundle (changelog, known issues, QA results) as a file, but keep the chat summary short.

## Failure conditions
NO-SHIP if any of: red check suite, dirty git, open security BLOCKER, committed secret, or manual media gates unrun for a milestone that touched voice/screen. Do not ship a beautiful UI with broken voice (CLAUDE.md §35).
