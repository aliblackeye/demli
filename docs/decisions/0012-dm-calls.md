# ADR 0012 — DM Calls: private 1-1 voice / video / screen, with seamless group upgrade

**Status:** accepted — shipped; DM calls are live on all clients (see also ADR 0022, 0023)
**Date:** 2026-07-16

## Context

Founder asks (memory [[dm-calls-requirements]]): from a DM, start a **private call** —
voice, video, or screen share — between the two friends. Concretely:

- **Mutual friendship required.** No call between non-friends (the same gate `POST /dms`
  already enforces).
- **Seamless upgrade to a group.** If a **third person is added** to a live call, a **new
  group is auto-created** and the call **moves into that group without hanging up**. The DM's
  message history stays private (the new group is a separate space).
- **A ringing incoming-call screen** (accept / decline) is a reasonable assumption.
- **Desktop + mobile parity** (memory [[mobile-experience-and-self-update]]).
- The call must obey the **single-active-voice-session** rule (memory
  [[single-voice-session-rule]]): a user is in at most one voice session across all devices;
  joining a new one evicts the old.

Fixed constraints going in (all verified in code):

- **A voice room is a LiveKit room named after a voice channel id.** `POST /media/token`
  (`apps/api/src/modules/media/index.ts`) mints `room: channelId` after checking the channel
  is a *visible voice channel the caller is a group member of* (`loadVisibleChannel`). A DM has
  **no voice channel** — only a hidden text stream channel (ADR 0010) — so a DM call has no
  room under today's rules.
- **Single-session is already keyed on an opaque room string.** `voice-session.ts` records
  `voice:session:<userId> = <room>` in Redis and evicts when the user joins a *different*
  room (`shouldEvictVoiceSession`), force-removing the old SFU participant and publishing the
  existing **`voice.session_replaced`** event. The room string is opaque — it does not have to
  be a channel id.
- **The mutation bus already has a `userId` scope.** `RealtimeMutation` sets exactly one of
  `channelId` / `groupId` / `userId` (`packages/db/src/redis/mutation-bus.ts`). Social events
  (`friend.*`, `dm.created`) fan out user-scoped through `connectionsByUser`, and the gateway's
  `handleUserMutation` forwards **any** user-scoped server event generically. A new
  user-scoped `call.*` event therefore needs **no new gateway routing code** to be delivered.
- **The message + realtime pipeline is kind-agnostic** (ADR 0010): any `friend_groups` row with
  a channel flows into a user's subscriptions. A new group with a voice channel wires up through
  the existing `member.joined` / `channel.created` gateway handlers.
- **The voice FSM + LiveKit engine (`packages/media`) already handle** join/leave, mute/deafen,
  camera, screen share, reconnect, and per-participant tracks for a voice room. A DM call **is**
  a 2-person voice room — the in-call surface is the existing `VoicePanel` / video stage
  (#9, [[video-stage-requirements]]), not a new media stack.
- Migrations run through `0010_google_auth`; this work is **migration 0011**.

Nothing here touches a §33 human-approval item (no app name / auth method / LiveKit
cloud-vs-self-host / framework / DB-provider change — it reuses the existing LiveKit) or a §35
non-negotiable (no media over WebSocket; no full permission hierarchy — a call is gated by a
two-state friendship, not a permission system).

## Decision

### 1. Three planes, cleanly separated

| Plane | Transport | Carries |
| --- | --- | --- |
| **Control** | HTTP `/dm-calls/*` (API) | start / accept / reject / cancel / hangup / upgrade; mints tokens; writes the call log; runs the mutual-friend gate and rate limits |
| **Notification** | user-scoped `call.*` events over the mutation bus | ring the callee, tell the caller the outcome, move both on upgrade |
| **Media** | LiveKit room | audio / video / screen frames — never WebSocket |

Control is HTTP (not client→server WS) for the same reason `friend.*` / `dm.*` are: the DB
friend-gate, the call-log write, token minting (`livekit-server-sdk`), rate limiting, and
offline push all already live in the API. The gateway stays a thin fan-out. This mirrors the
existing pattern exactly — the API publishes user-scoped events, the gateway forwards them.

### 2. The call room = an ephemeral LiveKit room, not a channel

A DM call runs in a LiveKit room named **`dmcall:<callId>`**, where `callId` is a fresh uuid
per call. It is **not** a `channels` row. Rationale:

- Keeps the DM a pure "hidden text stream" — no meaningless voice channel bolted onto every DM,
  no DM voice channel leaking into occupancy snapshots or channel lists.
- Reuses the single-session registry **unchanged** — `recordAndEvict(userId, "dmcall:<callId>")`
  treats the call room like any other room string, so joining a call evicts a prior group
  voice session (and vice versa) with zero new code.
- Reuses the LiveKit engine **unchanged** — `JOIN { roomId }` with a pre-minted token.

Token minting is **folded into the call lifecycle endpoints** (start returns the caller's token,
accept returns the callee's), so there is exactly **one** authorization path for a call-room
token — the gated call flow. There is deliberately **no** "mint me a token for an arbitrary
room" endpoint (that would be an abuse surface). `/media/token` (voice channels) is untouched.

### 3. Mutual-friend gate (server-side, every endpoint)

Every `/dm-calls/*` endpoint re-checks `friendships.getFriendshipWith(a, b).status === 'accepted'`
at call time. This matters because a DM **persists after unfriend** (ADR 0010: a DM is hidden,
never deleted) — so DM membership is **not** proof of a current friendship. The gate is the live
friendship, re-read per request, never trusted from the client (§28). Non-friend → `403`.

### 4. Signaling events (typed, user-scoped, server→client)

Added to `packages/protocol` (payloads carry a discriminated `CallTarget` so the **same** ring
covers a DM call and the group-upgrade ring):

```ts
type CallMedia = "audio" | "video";                 // initial intent; screen share is in-call
type CallTarget =
  | { kind: "dm"; dmId: DmId }
  | { kind: "group"; groupId: GroupId; voiceChannelId: ChannelId };
type CallEndReason =
  | "declined" | "canceled" | "timeout" | "hung_up" | "busy" | "failed" | "upgraded";

// call.invite    → callee   { callId, target, caller: User, media, expiresAt }
// call.accepted  → caller   { callId, target, callee: User }
// call.ended     → other    { callId, reason: CallEndReason }
// call.upgraded  → both originals { callId, group: Group, voiceChannelId }
```

`call.ended` collapses decline / cancel / timeout / hang-up / busy / failure into one event with
a typed `reason` — the recipient always knows its own role (the callee that receives
`reason:"canceled"` stops ringing; the caller that receives `reason:"declined"` shows "declined").
This mirrors how `friend.removed` collapses decline/cancel/unfriend. There are **no client→server
`call.*` events** — control is HTTP.

**Ringing timeout.** The call log stores `expires_at = created_at + RING_TIMEOUT` (default
**30 s**). Primary enforcement is **caller-client-driven**: the caller runs the timer and on
expiry calls `cancel(reason=timeout)`, which fans `call.ended{timeout}` to both and logs the call
`missed`. The server independently **rejects an accept after `expires_at`** (`409 expired`) so a
dead caller-client cannot leave a call ringable forever. A background sweeper for stale `ringing`
rows is a documented hardening follow-up, not MVP.

**Callee offline.** The user-scoped `call.invite` simply fans out to zero live connections, so we
**also** fire an offline push (reuse the existing `OfflineNotifier` used by friend requests /
mentions) — "Incoming call from X" — deep-linking (existing `app.$DOMAIN` host) into the
ringing screen. No accept within the window → `missed` + a DM system message ("Missed call").

### 5. Single-active-session interplay

The call room is just another room string, so all of single-session falls out for free:

- Start / accept a call while in a group voice channel → `recordAndEvict` evicts the group
  session (SFU removeParticipant + `voice.session_replaced`), and the joining device's `roomId`
  guard ignores the eviction for the room it just left. Clean handoff, no "voice server
  unavailable" error.
- **Busy policy (MVP default): ring anyway.** The callee may be in another room; accepting
  performs the single-session handoff. The incoming-call UI warns "you're in another call —
  accepting will leave it." A hard busy-reject is available (`call.ended{busy}`) but off by
  default. *(Open item for the Director — see below.)*

### 6. Seamless group upgrade — the room is rebound, not re-joined

The hard requirement is *uninterrupted* media when a third person is added. LiveKit cannot move a
participant between rooms server-side, so the naive "new group → new voice channel → new room"
forces the two originals to reconnect (a media gap). We avoid that by **letting a voice channel's
LiveKit room be an explicit name rather than its id**:

- Add a nullable **`channels.livekit_room text`**. The media token endpoint resolves
  `room = channel.livekitRoom ?? channel.id`. **Default null ⇒ room = channel id — every existing
  voice channel is unchanged.**
- On upgrade: create the group (`kind='group'`, `groupChats.create`), add all three members, and
  create a **voice channel whose `livekit_room` is the ongoing call's room** (`dmcall:<callId>`).
  The two originals are **already connected to that LiveKit room** — **zero reconnect, zero media
  gap**. The third person joins the group voice channel; its token resolves to the same room, so
  they land in the live call.
- Because `callId` is unique per call, `dmcall:<callId>` never collides with a **future** DM call
  on the same pair (which gets a new callId → new room).
- The originals' `voice:session` record already equals `dmcall:<callId>`, so re-minting a token
  for the new group voice channel compares equal → **no self-eviction**.

The upgrade is otherwise ordinary group creation: the server publishes **`member.joined`**
(group-scoped) for each of the three, which the existing gateway handler uses to index + subscribe
their connections, and **`call.upgraded`** (user-scoped) to the two originals so their UI navigates
from "DM call" to the group's voice channel and sends `voice.join {voiceChannelId}` for
**occupancy only** (media stays put). The third person receives a **`call.invite`** with
`target.kind === "group"` — the same ring, so they get an incoming-call experience for the group
voice; declining still leaves them a group member. **DM history is not copied** —
the new group has its own fresh text stream; the DM stream stays private.

Media continuity is thus **fully decoupled** from occupancy signaling (§10/§35): the WS layer only
tracks "who is in the channel"; LiveKit carries the audio, and the audio never moves.

### 7. Call log + DM call history

New table **`dm_calls`** (schema in the plan; the DB agent writes the migration) records
`id, dm_id, room_name, caller_id, callee_id, media, status, upgraded_to_group_id, created_at,
expires_at, started_at, ended_at`, with a **partial unique index on `dm_id WHERE status IN
('ringing','active')`** so a DM has at most one live call (idempotent start; a second start
returns the existing call / `409`). On every terminal outcome the API writes a **system message**
into the DM stream (reusing the existing `MessageKind='system'` pipeline) — "Call ended · 4:32",
"Missed call", "Call declined" — giving the DM an inline call history for free.

### 8. Domain type

Add `DmCall` (+ `CallId`, `CallStatus`, `CallMedia`, `CallEndReason`, `CallTarget`) to
`packages/types`. `MediaSession` (already in the domain but unused) stays as-is — a DM call's live
state is the LiveKit room + the voice FSM, not a persisted `MediaSession` row.

## Consequences

- **Small schema surface:** one table (`dm_calls`) + one nullable column
  (`channels.livekit_room`). No change to the message, DM, friendship, or group tables.
- **Near-zero new realtime code:** `call.*` are user-scoped events that ride the existing
  `handleUserMutation` fan-out; the upgrade reuses the existing `member.joined` wiring. The
  gateway change is essentially test coverage.
- **The in-call experience is the existing voice/video UI**, entered from a DM instead of a
  channel — screen share, camera focus/PiP, reconnect, quality all work unchanged because a call
  room is a LiveKit voice room.
- **Truly uninterrupted upgrade** for the two originals (room rebind, no reconnect), which is the
  founder's firmest ask; the third person's join is an ordinary voice join.
- **New concept to hold:** "a voice channel's LiveKit room may be an explicit name." It is
  well-contained (one column, one `??` in the token endpoint) and reusable (it is also the
  mechanism a future "drag me to another channel / persistent call room" would use).
- **Token authority stays server-side:** tokens are only minted through the gated call flow or the
  existing gated `/media/token`; there is no arbitrary-room token endpoint.
- **Deferred (documented, not built in MVP):** native CallKit/Connection+Service incoming-call
  UI on mobile (in-app ring + push for MVP); a server-side ring sweeper; a hard busy-reject
  policy; blocking (already deferred by ADR 0010).

**Open items for the Project Director / founder (reasonable defaults chosen; not blocking):**

1. **Ring timeout** — default 30 s.
2. **Third-person friendship** — default: the inviter must be mutual friends with the third
   person; the *other* original need not be. Alternative: require mutual friendship
   with both.
3. **Busy policy** — default: ring anyway (single-session handles the handoff). Alternative: hard
   busy-reject.
4. **Mobile native call UI** — default: in-app ring + push for MVP; CallKit/ConnectionService as a
   later hardening ADR.

## Alternatives considered

1. **Give every DM a real hidden voice channel; reuse `/media/token` verbatim.** Rejected: it
   pollutes the channel model (a meaningless voice channel on every DM), surfaces DM "voice
   channels" in occupancy snapshots, and still needs a *live* mutual-friend re-check at call time
   (channel membership survives unfriend), so it buys little over the ephemeral room while costing
   model clarity.
2. **Client "make-before-break" room switch on upgrade** (connect to a new group room, then leave
   the call room). Rejected as the primary strategy: it needs the media engine to briefly hold two
   rooms (or accept a sub-second audio gap), which weakens the "kesintisiz" guarantee the founder
   asked for. The `livekit_room` rebind (§6) gives a *true* zero-gap move at the cost of one
   nullable column, and is simpler on the client. (The make-before-break path remains the natural
   fallback if a LiveKit constraint ever makes rebind impossible.)
3. **Decouple room-name from channel-id for *all* channels from day one** (make `livekit_room`
   authoritative everywhere). Rejected as overreach: the nullable column with an `id` default
   delivers the upgrade with zero migration risk to existing rooms; a blanket decoupling is a
   larger change with no MVP payoff.
4. **Deterministic call room `dmcall:<dmId>`** (stable per DM). Rejected: after an upgrade the
   group voice channel keeps that room name, so a *future* DM call on the same pair would collide
   with the group's room. A per-call uuid removes the collision; call idempotency is enforced by
   the `dm_calls` partial unique index instead.
5. **Client→server `call.*` WS verbs** (put signaling on the gateway, like `voice.join`).
   Rejected: the mutual-friend gate, call-log write, token minting, rate limiting, and offline push
   all live in the API. HTTP control + user-scoped fan-out reuses the exact `friend.*`/`dm.*`
   pattern and keeps the gateway media-signaling-thin (§10).
6. **Server-timer-enforced ring timeout.** Rejected for MVP: a per-call in-process timer is fragile
   across API restarts / multiple instances. Caller-client timeout + a server `expires_at` accept
   guard is robust without shared timer state; a sweeper can harden it later.
