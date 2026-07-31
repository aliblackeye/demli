---
name: realtime-event-design
description: Design or review realtime WebSocket events against the typed contract in packages/protocol. Use when adding/changing any realtime event, or reviewing diffs in packages/protocol, apps/realtime, or WebSocket client code.
---

# Realtime Event Design

## When to use
Adding a new realtime event, changing an event payload, or reviewing any diff that touches `packages/protocol/src/`, `apps/realtime/src/`, or WebSocket client code in the renderer.

## Inputs
- The event(s) to add/change: name, direction, payload, emitter, consumers.
- Current contract in `packages/protocol/src/`.

## Procedure
1. Confirm the event belongs on WebSocket at all: chat, presence, typing, and lightweight voice/screen *signaling* only (CLAUDE.md §10). Audio/video frames or media data → reject, that is WebRTC/LiveKit territory.
2. Name it in the established `domain.action` style: `message.created`, `message.updated`, `message.deleted`, `typing.started`, `typing.stopped`, `presence.updated`, `voice.joined`, `voice.left`, `voice.muted`, `voice.unmuted`, `screen.started`, `screen.stopped`. Client→server uses imperative (`message.send`, `voice.join`); server→client uses past tense.
3. Add it to the discriminated union in `packages/protocol/src/` — `ClientToServerEvent` or `ServerToClientEvent` per CLAUDE.md §24 — as `{ type: "...", payload: TypedPayload }`. Payload DTOs reference types from `packages/types`.
4. Add a zod schema next to the type so the gateway can validate at the boundary; server must reject unknown event types and malformed payloads.
5. Verify both directions are covered where relevant (e.g. `voice.join` request → `voice.participant_joined` broadcast).
6. Grep consumers: no string literal event names outside `packages/protocol` (`rg '"(message|typing|presence|voice|screen)\.' --glob '!packages/protocol/**'`).
7. Consider replay/ordering: does the client need an ack or sequence to avoid duplicate/ghost messages (CLAUDE.md §22 chat gates)?
8. Run `pnpm --filter @demli/protocol typecheck` and `pnpm typecheck`.

## Checklist
- [ ] Event carries no media frames (WebSocket-appropriate)
- [ ] Name follows `domain.action`, tense matches direction
- [ ] Member of the typed discriminated union in `packages/protocol`
- [ ] zod schema validates the payload at the gateway boundary
- [ ] Payload types come from `packages/types` / protocol DTOs
- [ ] No magic-string event names outside `packages/protocol`
- [ ] Ordering/duplicate behavior considered for chat events
- [ ] `pnpm typecheck` passes

## Output format
The final type + schema additions (or a diff review verdict), the list of affected consumers, and PASS/FAIL per checklist item.

## Failure conditions
FAIL if: media data over WebSocket, an untyped or string-literal event ships, the gateway accepts unvalidated payloads, or typecheck breaks. Renaming an existing event without migrating all consumers in the same change is also a FAIL.
