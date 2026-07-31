# ADR 0005 — Servers and Groups

**Status:** accepted
**Date:** 2026-07-05

## Context

The product needs two distinct social shapes:

- **Server** — the existing multi-channel space (`#general`, `#games`, voice `Lobby`…),
  owned by one person, with many members. This is the current `FriendGroup`.
- **Group** — a lightweight, flat chat: no channel list, no rail of rooms, just one
  conversation shared by a small set of people (think a DM-style thread for a friend
  pair or trio). This is the primary surface for the "film night" flow (ADR 0004): two
  people, one stream, one screen share.

The whole message + realtime pipeline the app already has is **channel-scoped**: messages
belong to a `channelId`, pagination keys on `(channel_id, created_at, id)`, the WS gateway
subscribes/broadcasts per channel, the nonce idempotency index is per author, and the
mutation bus routes by `channelId`. Introducing a second, parallel "group message" path
would duplicate all of that and guarantee drift on the most protocol-sensitive code we own.

## Decision

**A Group is a `friend_groups` row with `kind = 'group'` that owns EXACTLY ONE
auto-created hidden text channel.** That channel's id is the Group's message `streamId`.
A **Server** is the same table with `kind = 'server'` (the default; every pre-existing
row). We do **not** rename `FriendGroup`; we add a `kind` discriminant.

Consequences of that single decision:

- **Groups reuse the channel pipeline unchanged.** Sending/reading/paginating a Group's
  messages is just sending/reading/paginating its stream channel — no new message table,
  no new WS routing, no new pagination. The channel is "hidden" only in the sense that
  clients never render a Group as a channel list; the row is a normal `channels` row
  (`kind='text'`, name `"stream"`, position 0).

- **`streamId` is a `ChannelId` exposed on the `Group` DTO.** This is a deliberate,
  documented leak of an internal identifier into the client contract. It is the price of
  reuse: the client uses `streamId` directly as the channel key for `GET /channels/:id/
  messages`, the `message.send` WS event, typing, etc. We accept the leak because the
  alternative (a translation layer mapping "group id" → "hidden channel id" on every
  message call) buys nothing but indirection. The name `streamId` (not `channelId`) keeps
  the group's conceptual model — "one stream of messages" — at the surface.

- **`/groups` stays server-only for back-compatibility.** `groupsRepo.listForUser` now
  filters by `kind`, defaulting to `"server"`, so the existing `GET /groups` endpoint and
  every current caller keep returning exactly the servers they returned before the `kind`
  column existed. Flat group chats are a separate surface (`groupChatsRepo`, and a future
  `/group-chats` endpoint in Wave 1) — they never contaminate the server list, and vice
  versa.

- **The migration is additive and metadata-only.** `0002_add_friend_group_kind.sql`:
  `CREATE TYPE friend_group_kind AS ENUM('server','group')` + `ALTER TABLE friend_groups
  ADD COLUMN kind ... NOT NULL DEFAULT 'server'`. On PostgreSQL 11+ adding a `NOT NULL`
  column with a **constant** default is a catalog-only change — no table rewrite, no long
  lock — so it is safe to run against the live database at deploy time. The added
  `friend_groups_kind_idx` is a plain (non-`CONCURRENTLY`) `CREATE INDEX`; `friend_groups`
  is tiny (one row per space), so the brief build lock is negligible. `channels`,
  `messages`, and `friend_group_members` are untouched.

## Consequences

- One message/realtime/pagination pipeline serves both servers and groups → far less code
  and zero protocol drift.
- The `Group` DTO carries `streamId: ChannelId`; clients must treat it as the channel key
  for all message operations. Documented here so it is an intentional contract, not an
  accident.
- `FriendGroup` gains a required `kind` field. All construction goes through
  `toGroup`/`toServer`/`toGroupChat` mappers, so apps are unaffected; only the type widens.
- Servers and groups share the `friend_groups` and `friend_group_members` tables, so
  membership, ownership, and cascade-delete semantics are identical and already tested.
- A Group is fixed at exactly one channel by construction (created in one transaction).
  If a future feature needs a group to grow channels, it becomes a server — there is no
  half-state.

## Wave plan (this ADR covers Wave 0 only)

- **Wave 0 (this change):** shared types (`FriendGroupKind`, `Server`, `Group`,
  `GroupMember`), the additive migration, `groupChatsRepo`, mapper + seed + tests. No API,
  client-core, or UI changes.
- **Wave 1 (API):** `/group-chats` endpoints built on `groupChatsRepo`
  (create/list/details/add-member/remove-member); message endpoints reuse `streamId`
  as the channel. A `GroupDTO` in `@demli/client-core` mirrors the `Group` type.
- **Wave 2 (UI):** desktop + mobile surfaces for the flat group chat.

## Alternatives considered

- **A separate `group_messages` table + parallel realtime path.** Rejected: duplicates
  pagination, nonce idempotency, WS routing, and the mutation bus — the exact drift ADR
  0002 exists to prevent.
- **Groups without a backing channel (message.group_id nullable, channel_id nullable).**
  Rejected: forces every message query, index, and WS route to branch on "channel vs
  group", touching the hottest code in the system and breaking the clean channel key.
- **A polymorphic `conversations` table above channels/groups.** Rejected as
  over-engineering for the MVP; the `kind` discriminant on `friend_groups` gives the same
  outcome with one column and zero new tables.
