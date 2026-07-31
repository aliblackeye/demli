# Message Enrichment — Implementation Plan (M14, ADR 0011)

> **Shipped — this is the plan as written, kept as a record.** Reactions and replies (ADR 0011) are live; mentions and search shipped in later waves. It reads as
> forward-looking work orders because that is what it was; it is not a list of pending
> work. Current per-platform status lives in `docs/product/feature-parity.md`.

Reference: ADR 0011. Scope: emoji reactions (add/remove + counted display) and replies
(quote a message with an inline preview). Migration **0008**. Mention (`@`) and search are
**phase 2** — room reserved in ADR 0011 §5, not built here.

Rule: `docs/**` is written by product-architect; every code section below is owned by the
named agent on the named branch. Nothing hits a §33 human-approval item. The one cross-cut is
file overlap with the in-flight M13 (ADR 0010) — see §7.

## 1. Migration 0008 schema (owner: database)

`packages/db/migrations/0008_message_enrichment.sql` + matching `packages/db/src/schema.ts`.

```sql
-- Reactions: one row per (message, user, emoji). PK is the idempotency guard.
CREATE TABLE message_reactions (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  emoji      text NOT NULL,                          -- canonical unicode from REACTION_EMOJI
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);
-- No secondary index: the PK leads with message_id, covering the per-page
-- `WHERE message_id IN (…)` aggregation as a range scan.

-- Replies: nullable self-FK. SET NULL is the safety net for genuine row removal;
-- the common path is a soft-deleted target (row kept), rendered as a "deleted" stub.
ALTER TABLE messages
  ADD COLUMN reply_to_message_id uuid REFERENCES messages(id) ON DELETE SET NULL;
CREATE INDEX messages_reply_to_idx
  ON messages(reply_to_message_id) WHERE reply_to_message_id IS NOT NULL;
```

All additive / catalog-only; no table rewrite. `schema.ts`: add the `messageReactions`
`pgTable` (composite PK via `primaryKey({ columns: [...] })`) and the `replyToMessageId`
column on `messages` using the lazy `AnyPgColumn` self-reference pattern already used for
`friend_groups.systemChannelId`.

## 2. Types, config & protocol (owner: product-architect)

**`packages/config/src/index.ts`**

```ts
export const REACTION_EMOJI = ["👍", "❤️", "😂", "🎉", "😮", "😢", "🙏", "🔥"] as const;
export type ReactionEmoji = (typeof REACTION_EMOJI)[number];
export const REPLY_PREVIEW_MAX = 120;   // chars of the target content carried in the preview
export function isReactionEmoji(v: string): v is ReactionEmoji {
  return (REACTION_EMOJI as readonly string[]).includes(v);
}
```

**`packages/types/src/index.ts`**

```ts
export interface MessageReactionSummary { emoji: string; count: number; reactedByMe: boolean }
export interface MessageReplyPreview {
  id: MessageId; authorId: UserId; content: string; kind: MessageKind; deleted: boolean;
}
// on Message (both optional/additive — absent === none, pre-M14 fixtures unchanged):
//   reactions?: MessageReactionSummary[];
//   replyTo?: MessageReplyPreview | null;
```

**`packages/protocol/src/events.ts` (+ schemas.ts + factories.ts)**

- `SendMessagePayload` gains `replyToMessageId?: MessageId` (optional; schema `id.optional()`).
- `MessageDTO` (`messageDTOSchema`) gains optional `reactions` + `replyTo` mirroring the types.
- Two new **channel-scoped** server→client events + payloads + zod schemas + `serverEvent.*`
  factories + `SERVER_EVENT` constants, added to the `serverToClientEventSchema` union (the
  mutation-bus codec validates against it):

```ts
{ type: "message.reaction_added";   payload: { channelId: ChannelId; messageId: MessageId; emoji: string; userId: UserId } }
{ type: "message.reaction_removed"; payload: { channelId: ChannelId; messageId: MessageId; emoji: string; userId: UserId } }
```

The compile-time `_assertServer` / `_assertClient` mutual-assignability checks keep schemas
and unions in sync — extend both sides together or it fails to build.

## 3. DB repositories & mappers (owner: database)

**`packages/db/src/repositories/message-reactions.ts`** (new):

- `add(messageId, userId, emoji)` — `INSERT … ON CONFLICT (message_id,user_id,emoji) DO
  NOTHING`; returns `{ added: boolean }`.
- `remove(messageId, userId, emoji)` — keyed `DELETE`; returns `{ removed: boolean }`.
- `summariesForMessages(messageIds, viewerId): Map<MessageId, MessageReactionSummary[]>` —
  one grouped query (`GROUP BY message_id, emoji`, `count(*)`, `bool_or(user_id = viewerId)`),
  ordered `min(created_at)`; groups in app. No-N+1, mirrors `attachments.listForMessages`.
- `deleteForMessage(messageId)` — used by `messages.softDelete` to reap reactions.

**`packages/db/src/repositories/messages.ts`**:

- `create` accepts optional `replyToMessageId` (persisted on insert; unchanged nonce/upsert
  idempotency path).
- `getReplyPreviews(targetIds): Map<MessageId, MessageReplyPreview>` — one `WHERE id IN (…)`
  lookup; maps each row to `{ id, authorId, content: deleted ? "" : content.slice(0,
  REPLY_PREVIEW_MAX), kind, deleted: deletedAt !== null }`. Lives here (not `apps/api/lib`)
  so **both** the API and the gateway import it.
- `softDelete` additionally calls `messageReactions.deleteForMessage`.

**`packages/db/src/mappers.ts`**: `toMessage` carries `replyToMessageId` through (the raw id;
the *preview* is built by enrichment, not the mapper). Seed data may add a couple of reactions
+ one reply for manual QA.

Repo tests: reaction add/remove idempotency (double add = one row, double remove = no error);
summary counts + `reactedByMe` for viewer vs other; reply-preview batch incl. a soft-deleted
target (`deleted: true`, blanked content) and a hard-deleted target (absent from map → null).

## 4. API (owner: realtime-backend) — branch `feat/enrich-api`

**`apps/api/src/lib/message-enrichment.ts`** (new, beside `attachments.ts`):

- `enrichMessagesWithReactions(repos, messages, viewerId)` and
  `enrichMessagesWithReplyPreviews(repos, messages)` — each one batched query, graft onto DTOs.
- A single `enrichMessages(repos, messages, viewerId)` that chains attachments → reactions →
  reply previews, so the list/create paths call one function.

**`apps/api/src/modules/messages/index.ts`**:

- `GET /channels/:channelId/messages` — swap `enrichMessagesWithAttachments` for the combined
  `enrichMessages` (adds reactions + reply previews to the page). `viewerId = user.id`.
- `POST /channels/:channelId/messages` — accept `replyToMessageId` in the body; validate the
  target exists and `target.channelId === channelId` (else `400 INVALID_PAYLOAD`); pass to
  `messages.create`; enrich the 201 response via `enrichMessages`.
- **`PUT /messages/:messageId/reactions/:emoji`** — `authenticate`; `loadVisibleChannel`
  (invisible ⇒ 404); validate `isReactionEmoji(:emoji)` (else `400 INVALID_REACTION`);
  `reactions.add`; publish channel-scoped `serverEvent.messageReactionAdded({ channelId,
  messageId, emoji, userId })`; return `{ reactions: summariesForMessages([messageId],
  user.id) }`. Rate limit `{ max: 30, timeWindow: "10 seconds", keyGenerator: perSessionKey }`.
- **`DELETE /messages/:messageId/reactions/:emoji`** — same guards; `reactions.remove`;
  publish `messageReactionRemoved`; return the updated summary.

Publishing reuses the existing `mutationBus.publish({ channelId, event })` (channel scope) —
**no bus change**.

## 5. Gateway (owner: realtime-backend) — branch `feat/enrich-gateway`

**`apps/realtime/src/gateway.ts`**, `handleMessageSend` only:

- Destructure `replyToMessageId` from the payload. If present, `findById` the target and
  reject (`INVALID_PAYLOAD`, echo the nonce) when it is missing or `target.channelId !==
  channelId`.
- Pass `replyToMessageId` to `messages.create`.
- Before broadcasting, build the reply preview via `messages.getReplyPreviews([message.id-
  target])` (or a single-target helper) and attach it: `serverEvent.messageCreated({
  ...message, replyTo, nonce })`.

**Reactions need no gateway change** — the two events are channel-scoped and the existing
`mutationBus.subscribe` channel branch (`broadcastToChannel(mutation.channelId,
mutation.event)`) already fans them to subscribers. A brand-new message has zero reactions, so
`message.created` carries none.

## 6. Client work

### 6a. Desktop (owner: frontend-ui) — branch `feat/enrich-desktop`

**`MessageRow.tsx`** — revive the three mock hover actions:

- *Add reaction* (`SmilePlus`) → opens a small Radix popover of the `REACTION_EMOJI` palette;
  picking one calls the optimistic add.
- *Reply* (`Reply`) → sets the composer's reply target (store slot below).
- *More* (`MoreHorizontal`) → a `ContextMenu` with **Reply**, **Add reaction**, **Copy text**,
  and — since the `PATCH`/`DELETE` endpoints already exist — **Edit**/**Delete** for own
  messages (Delete also for `MANAGE_MESSAGES`). Wiring these removes the last dead affordance;
  if scope-trimmed, at minimum wire Reply + Add reaction and keep *More* honest.
- **Reaction pills** row under the content: one pill per summary entry (`emoji count`),
  `reactedByMe` styled active; click toggles (add/remove). Keyboard/aria per `ui-quality`.
- **Reply preview** line above the author row: a dimmed `↳ @name: preview…`, click scrolls to
  the target (by `replyTo.id`); `deleted` renders *"Original message was deleted."*

**`MessageComposer.tsx`** — a **reply banner** above the input (*Replying to @name* + ✕ to
cancel) driven by the store slot; include `replyToMessageId` in `sendChatMessage`. The dead
*Add emoji* button stays out of M14 scope (it is a text-insert picker, ADR 0011 §7) — either
leave its honest tooltip or, optionally, wire the same palette popover to insert a character
at the cursor (cheap, removes the button; not required).

**`MessageList.tsx`** — extend `estimateSize`: add ~28px when `message.reactions?.length`,
~24px when `message.replyTo`, so the initial estimate stays close and `measureElement`
correction doesn't jump the scroll (§27). Confirm add/remove re-measure keeps the
stick-to-bottom + load-older anchoring intact (QA gate below).

**`stores/chat-store.ts`** — a `replyTarget: { channelId, message } | null` slot
(set/clear); optimistic reaction helpers that patch a message's `reactions` in place and
support rollback.

**`realtime/connection.ts`** — handle `message.reaction_added` / `message.reaction_removed`:
fold the delta into the cached `MessageDTO.reactions` (new `updateMessageReactions` cache
helper alongside `insertMessage`/`replaceMessage`); dedupe the initiator's own echo. `replyTo`
already flows in via `message.created` → `insertMessage`, no change.

### 6b. Mobile (owner: frontend-ui / mobile) — branch `feat/enrich-mobile`

Mobile has **no** action affordance today — build the mobile pattern, not a button revival:

**`MessageBubble.tsx`** — `onLongPress` opens an action sheet (RN `ActionSheet`/bottom sheet):
**React** (reveals the `REACTION_EMOJI` palette), **Reply**, **Copy**, **Delete** (own /
`MANAGE_MESSAGES`). **Reaction pills** row under the bubble (tap toggles). **Reply preview**
line above the bubble (tap scrolls to target; deleted stub as on desktop).

**`ChatThread.tsx`** — reply banner above `Composer`; thread the reply target into the send.
Mobile chat-store mirrors the desktop reply-target slot + optimistic reaction patch, and the
mobile realtime handler folds the two reaction events (same logic as 6a).

### 6c. Shared client-core note

If a shared client-core exists (ADR 0002), the cache helpers + event folding live there once
and both apps import them; otherwise mirror the small delta logic in each. Keep the
`REACTION_EMOJI` palette imported from `@demli/config` on both — never re-typed.

## 7. Wave partitioning & M13 parallelism

### M14 waves

| Wave | Owner | Branch | Depends on | Est |
|---|---|---|---|---|
| **W1 Types + config + protocol** | product-architect | `feat/enrich-types` | M13 W1a merged (shared files, §7.2) | 0.5d |
| **W2 Migration 0008 + repos + mappers + seed + tests** | database | `feat/enrich-db` | W1; M13 W1b merged (shared `schema.ts`/`mappers.ts`) | 1.5d |
| **W3 API (reaction endpoints + list/create enrichment)** | realtime-backend | `feat/enrich-api` | W2 | 1.5d |
| **W4 Gateway (reply over WS)** | realtime-backend | `feat/enrich-gateway` | W2; M13 W3 merged (shared `gateway.ts`) | 0.5d |
| **W5 Desktop UI** | frontend-ui | `feat/enrich-desktop` | W3 (+W4 for reply send) | 2d |
| **W6 Mobile UI** | frontend-ui / mobile | `feat/enrich-mobile` | W3 (+W4) | 1.5d |
| **W7 QA + security review** | qa-test + security | `feat/enrich-qa` | W5, W6 | 1d |

Order: **W1 → W2 → {W3 ∥ W4} → {W5 ∥ W6} → W7.** W3 and W4 are file-disjoint (API module vs
gateway) and both depend only on W2, so they run in parallel. W5/W6 are separate app trees.

### 7.2 File overlap with M13 (ADR 0010, in flight) — which waves may run parallel

M14 and M13 both edit a handful of **shared files additively** (no semantic conflict, but the
same file = a git-serialization point). The rule: an M14 wave that touches a shared file
**rebases onto `dev` after the matching M13 wave merges**; everything else is free.

| File | M13 wave | M14 wave | Parallel-safe? | Resolution |
|---|---|---|---|---|
| `packages/types/src/index.ts` | W1a | W1 | **No** | M14 W1 branches after M13 W1a merges; both additive |
| `packages/protocol/{events,schemas,factories}.ts` | W1a | W1 | **No** | serialize with M13 W1a (union edits) |
| `packages/db/src/schema.ts` | W1b | W2 | **No** | M14 W2 rebases after M13 W1b (different tables/cols) |
| `packages/db/src/mappers.ts` | W1b | W2 | **No** | serialize with M13 W1b (`toMessage` vs friendship maps) |
| `apps/realtime/src/gateway.ts` | W3 | W4 | **No** | different functions (M13: `subscribe`/presence/`dm.created`; M14: `handleMessageSend`) — merge M14 W4 after M13 W3 |
| `packages/config/src/index.ts` | — | W1 | **Yes** | M13 doesn't touch config |
| `packages/db/src/redis/mutation-bus.ts` | W1c (adds `userId`) | — | **Yes** | M14 reuses the existing `channelId` scope — no bus edit |
| `apps/api/src/modules/messages/index.ts` | — | W3 | **Yes** | M13 touches `users`/`friends`/`dms`, not messages |
| `apps/api/src/app.ts` | W2 | — | **Yes** | M14 adds endpoints inside the already-registered messages module — no `app.ts` change |
| `packages/db/src/repositories/message-reactions.ts` | — | W2 | **Yes** | new file, M14-exclusive |
| `apps/desktop` message components | W4 (HomeView/GroupRail) | W5 (MessageRow/List/Composer) | **File-safe** | disjoint components; **owner contention** — `frontend-ui` runs both (see note) |
| `apps/mobile` | W5 (friends/dms screens) | W6 (MessageBubble/ChatThread) | **File-safe** | disjoint files; same owner-contention note |

**Net:** M14's three shared-file waves (**W1** types/protocol/config, **W2** db, **W4**
gateway) must land *after* the corresponding M13 waves (W1a, W1b, W3) — a clean rebase, since
every edit is additive. M14's independent work (**W3** API messages module, the new
`message-reactions` repo, config palette, desktop `MessageRow`/mobile `MessageBubble`) is
file-safe against M13 and can be developed concurrently, integrating (typecheck) once the
shared types are on `dev`.

**Owner contention, not file conflict:** `frontend-ui` owns M13 W4/W5 *and* M14 W5/W6. The
files are disjoint (HomeView vs MessageRow; friends screens vs MessageBubble), so they are
merge-safe, but a single agent can only do them in series — schedule M14's UI after M13's UI,
or split to a second frontend agent if capacity allows (§30 file ownership is satisfied either
way).

## 8. Test plan (owner: qa-test; security reviews §9)

- **DB**: reaction add/remove idempotency (double add ⇒ one row; remove-nonexistent ⇒ no
  error); summary counts + `reactedByMe` for viewer vs other; reply-preview batch with
  soft-deleted target (`deleted: true`, blank content) and hard-deleted target (SET NULL ⇒
  absent ⇒ null); `softDelete` reaps reactions.
- **API**: `PUT`/`DELETE` idempotency; emoji-not-in-palette ⇒ `400`; react on an invisible
  restricted channel ⇒ `404` (no leak); reply to a message in another channel ⇒ `400`; reply
  to a soft-deleted message ⇒ 201 with a `deleted` preview; list/create carry reactions +
  `replyTo`; reaction rate limit (~30/10s).
- **Realtime**: `reaction_added`/`removed` reach every channel subscriber and fold correctly
  (count + `reactedByMe`); reply preview arrives inside `message.created` over WS; a reaction
  on a message not in the client's loaded pages is a safe no-op; seq-gap refetch restores
  authoritative counts.
- **Client**: optimistic add renders instantly and rolls back on `error.raised`; the
  initiator's own echo does not double-count; pills toggle; reply banner sets/clears and the
  sent message shows the preview; **virtualization** — adding/removing a reaction or rendering
  a reply line does not break stick-to-bottom or older-page anchoring (§27).
- **E2E smoke**: send → reply to it (preview shows) → react 👍 (pill count 1, active) →
  second user reacts 👍 (count 2) → un-react (count 1) → delete the replied-to message (the
  reply now reads "deleted").
- **Security (§28)**: reaction/reply authorization rides `loadVisibleChannel` (no cross-channel
  or invisible-channel access); reply preview content is escaped exactly like message content
  (no HTML/markdown injection via a quoted message); emoji strictly whitelisted.

## 9. Validation

- `pnpm typecheck` (**mandatory** — `packages/types` + `packages/protocol` change).
- `pnpm lint`; `pnpm test` (db repo + api + realtime + protocol contract).
- Migration 0008 applies cleanly on a copy of a seeded DB; `message_reactions` PK dedups a
  double-insert; the `messages_reply_to_idx` partial index is present.
```
