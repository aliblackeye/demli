---
name: webrtc-media-review
description: Review voice/screen-share code against the voice state machine and media lifecycle rules. Use before merging any change to packages/media, LiveKit integration, device handling, or screen-share code.
---

# WebRTC Media Review

## When to use
Any diff touching `packages/media/src/`, LiveKit usage, voice UI wiring, device selection, or screen-share flows. Mandatory before merging Milestone 3 (Voice MVP) and Milestone 4 (Screen Share MVP) work.

## Inputs
- The diff plus the current voice state machine in `packages/media/src/`.
- The manual media test results if available (`.claude/reports/`).

## Procedure
1. Transport check: microphone audio, screen video, camera video flow ONLY over WebRTC/LiveKit. Any media frames, audio chunks, or track data routed through the WebSocket gateway is an automatic FAIL (CLAUDE.md §10, §35).
2. State machine check (CLAUDE.md §11): voice status is a single source of truth in `packages/media` covering `idle | joining | connected | reconnecting | error` (+ leaving), with `micEnabled`, `deafened`, `screenShareEnabled`, device ids, and `participants` in one typed state shape — not scattered React booleans.
3. Transition audit — every lifecycle event has an explicit handler: join, leave, mute, deafen, input device change, output device change, network drop, reconnect start/success/failure, screen share start/stop, permission denied, device not found, track ended unexpectedly.
4. Error mapping: each media failure becomes a typed, user-friendly error (CLAUDE.md §26) — mic permission denied, no mic found, selected mic unavailable, screen permission denied, source closed. No raw exceptions to the UI.
5. Reconnect: verify reconnecting → connected restores tracks and participant state, and reconnecting → error is reachable and handled (no infinite spinner).
6. Screen share: track-ended (user closes source window) transitions state cleanly; focus mode gets the track without duplicating lifecycle logic in UI.
7. Leak check: listeners removed and tracks stopped on leave/error; no LiveKit room object held after `leaving` completes.
8. Run `pnpm --filter @demli/media typecheck` and `pnpm test`; list which CLAUDE.md §22 media gates still need a manual run.

## Checklist
- [ ] No media frames over WebSocket anywhere
- [ ] Single typed voice state in `packages/media`, matching the §11 shape
- [ ] All §11 lifecycle events have explicit transitions/handlers
- [ ] Media errors are typed and user-friendly, no raw stack traces
- [ ] Reconnect success AND failure paths implemented
- [ ] Screen-share track-ended handled
- [ ] Tracks/listeners cleaned up on leave and on error
- [ ] Typecheck + tests pass; outstanding manual gates listed

## Output format
Terse, in chat (CLAUDE.md §0.1): overall verdict, then only FAIL items with file:line evidence, any unhandled lifecycle events (should be empty), and the manual gates still to run. Passing items collapse to one line. A `.claude/reports/` file only if the founder asks.

## Failure conditions
FAIL if: any media over WebSocket, voice state duplicated outside `packages/media`, any §11 lifecycle event silently unhandled, or reconnect failure path missing. "Works on happy path" is not a pass — priority order is voice > screen share > reconnect > chat > UI (CLAUDE.md §6).
