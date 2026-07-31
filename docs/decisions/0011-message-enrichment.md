# ADR 0011 — Message Enrichment (M14): Reactions & Replies

**Status:** accepted — shipped; reactions, replies, mentions and search are live
**Date:** 2026-07-09

## Context

Founder asks for M14: make the reply and emoji affordances that already sit in the
message UI actually work. Two features, in priority order:

1. **Emoji reactions** — add/remove a reaction on a message, shown as counted pills.
2. **Reply** — send a message that quotes a target, with an inline preview of it.

The buttons exist but are inert. Verified in code:

- **Desktop `MessageRow.tsx`** renders three hover actions — *Add reaction* (`SmilePlus`),
  *Reply* (`Reply`), *More* (`MoreHorizontal`) — all with the comment *"Hover actions —
  mock-only in Milestone 1"* and no handlers.
- **Desktop `MessageComposer.tsx`** has an *Add emoji* (`SmilePlus`) button tooltipped
  *"Emoji picker lands later"*, no handler. This is a **text-insert** picker, distinct from
  reactions (see Decision §7).
- **Mobile `MessageBubble.tsx`** has **no** action affordance at all — mobile needs a
  long-press menu built, not a dead button revived.
- There is **no dead search box** in the chat surface (`ChatView` header holds only wired
  Invite + member-toggle buttons), and no `@`-mention UI. Nothing to hide; §5 below.

Fixed constraints going in (all verified):

- The message + realtime pipeline is **channel-scoped**. `messages` carry `content`, `kind`,
  `nonce`, soft-delete columns, and (M10) `attachments`. Message reads/writes go through
  `loadVisibleChannel` (membership + role-visibility, ADR 0007).
- **DTO enrichment already has a proven no-N+1 pattern**: `enrichMessagesWithAttachments`
  bulk-loads a page's attachments in one `listForMessages` query and grafts them onto the
  DTOs. Reactions and reply previews follow this exact shape.
- **The realtime mutation bus is channel- or group-scoped** (`RealtimeMutation` sets one of
  `channelId` / `groupId`; ADR 0010 adds `userId`). Reactions and replies are **channel
  events** — they fit the existing `channelId` branch with **zero** new bus infrastructure.
  The gateway's `mutationBus.subscribe` channel branch already fans any channel-scoped event
  to that channel's subscribers, so the two new reaction events need **no gateway code**.
- **Migrations run through 0006; ADR 0010 (social, M13) reserves 0007.** This work is
  **migration 0008**.
- Messages are **soft-deleted** (row kept, `content` blanked, `deletedAt` set); hard deletes
  happen only via channel/message row removal (cascade).

Nothing here touches a §33 human-approval item (no app name / auth / LiveKit / framework /
DB-provider change) or a §35 non-negotiable (no media over WS; reactions are a flat
`(message, user, emoji)` relation, not a permission system). The one coordination hazard is
that M14 and the in-flight M13 both edit `packages/types`, `packages/protocol`,
`packages/db/schema.ts`/`mappers.ts` and `apps/realtime/gateway.ts` — handled by wave
sequencing, not by conflicting content (see the implementation plan §7).

## Decision

### 1. Reactions = a flat `message_reactions` table, one row per (message, user, emoji)

```txt
message_reactions   message_id uuid  → messages(id)  ON DELETE CASCADE
                    user_id    uuid  → users(id)      ON DELETE CASCADE
                    emoji      text                    -- canonical unicode from the palette
                    created_at timestamptz NOT NULL DEFAULT now()
                    PRIMARY KEY (message_id, user_id, emoji)
```

The PK **is** the idempotency guard: adding a reaction is `INSERT … ON CONFLICT DO NOTHING`,
removing is a keyed `DELETE`. No dedupe logic, no counter column to drift — the count is
always `count(*)` grouped by emoji. The PK leads with `message_id`, so the per-page
aggregation (`WHERE message_id IN (…)`) is an index range scan; **no extra index needed**.

**Emoji set: a fixed MVP palette, full picker deferred.** MVP restricts reactions to a
named palette in `@demli/config` (single source of truth, imported by client *and*
server — the same §23 pattern as `ATTACHMENT_LIMITS`):

```ts
export const REACTION_EMOJI = ["👍", "❤️", "😂", "🎉", "😮", "😢", "🙏", "🔥"] as const;
```

The server rejects any emoji outside this set (`400 INVALID_REACTION`). This buys a trivial,
secure validator (no unicode-grapheme parsing, no custom-emoji storage) and a fast quick-react
UX. The column is `text`, so **widening to an arbitrary-emoji picker later needs no
migration** — only the config set + validator relax (to NFC-normalize + validate the grapheme).
Because both sides import the exact literals, the multi-code-point forms (e.g. `❤️` =
`U+2764 U+FE0F`) never drift.

**DTO — aggregated per message, not per row.** A message carries a compact summary:

```ts
interface MessageReactionSummary { emoji: string; count: number; reactedByMe: boolean }
```

Built in one grouped query per page (`message_id IN (…)`, `GROUP BY message_id, emoji`,
`bool_or(user_id = :viewer)` for `reactedByMe`), ordered by each emoji's **first** occurrence
(`min(created_at)`) so pills keep a stable position as counts change. Attached to `Message`
as optional `reactions?: MessageReactionSummary[]` — absent/empty read identically, so
text-only messages and pre-M14 fixtures are unchanged.

On **soft delete**, the message's reaction rows are also cleared (a deleted message shows no
reactions and the row space is reclaimed); hard delete cascades them anyway.

### 2. Replies = a nullable self-FK on `messages`, with a lightweight preview in the DTO

```txt
messages   reply_to_message_id uuid  → messages(id)  ON DELETE SET NULL   -- nullable
           messages_reply_to_idx  (partial, WHERE reply_to_message_id IS NOT NULL)
```

A reply is **immutable** (set at send, never changed — our `PATCH` only touches
`content`). `ON DELETE SET NULL` is the safety net for genuine row
removal; the realistic path is a **soft-deleted target** (row still present, `deletedAt`
set), which the preview builder detects and renders as *"Original message was deleted."*
The partial index keeps the SET-NULL referrer lookup cheap without indexing the 99% of
messages that reply to nothing.

**DTO — a batch-built, N+1-free preview.** The reply target is denormalized into a small
preview on the replying message:

```ts
interface MessageReplyPreview {
  id: MessageId;
  authorId: UserId;          // client resolves the name from its users map — no user join
  content: string;           // first ~120 chars (REPLY_PREVIEW_MAX), blanked when deleted
  kind: MessageKind;
  deleted: boolean;          // true when the target row is soft-deleted
}
// on Message:  replyTo?: MessageReplyPreview | null
```

Built by collecting every `replyToMessageId` across a page and issuing **one**
`WHERE id IN (…)` lookup (mirrors `listForMessages`). The builder lives in **`packages/db`**
(not `apps/api/lib`) because **both** the API (list + REST create response) and the gateway
(the WS `message.created` broadcast) must build it, and only `packages/db` is imported by both
processes. The preview carries only `authorId` (not the whole user) to stay lean — the client
already holds the users map.

**Reply is set at send time.** `SendMessagePayload` and the REST create body gain optional
`replyToMessageId`. The server validates the target **exists and belongs to the same
channel** (`400 INVALID_PAYLOAD` otherwise) — you cannot quote a message from another channel.

### 3. Realtime — two new channel-scoped events for reactions; reply rides `message.created`

Reactions mutate over **HTTP** (like edits/deletes), then publish a **channel-scoped**
mutation on the existing bus:

```txt
message.reaction_added    { channelId, messageId, emoji, userId }   → channel subscribers
message.reaction_removed  { channelId, messageId, emoji, userId }   → channel subscribers
```

These are **deltas**, not full summaries — tiny payloads, and the client folds each into the
target message's cached summary (increment/decrement the emoji's count; toggle `reactedByMe`
when `userId` is me). The gateway's `mutationBus.subscribe` **channel branch already
broadcasts any channel-scoped event** — so these events need **no new gateway code**, only
the two publish calls in the API.

**Replies need no new event.** The preview is part of the `MessageDTO`, so it arrives inside
the normal `message.created` (WS broadcast) and the REST 201 response. The only gateway change
is that `handleMessageSend` must pass `replyToMessageId` to `messages.create` and enrich the
broadcast message with its reply preview.

**Optimistic reactions.** The client applies the delta immediately on tap (bump the count,
set `reactedByMe`), fires the HTTP `PUT`/`DELETE`, and rolls back on error. The server echo is
idempotent (the initiator has already applied it; dedupe by `(emoji, userId)`), and a missed
event self-heals on the reconnect refetch (`invalidateQueries(allMessages)` re-enriches with
authoritative counts). Reply has no optimistic-preview subtlety — the composer already has the
target message in hand, so the outbox row renders the preview locally before the echo.

### 4. Endpoints (idempotent PUT/DELETE verbs)

```txt
PUT    /messages/:messageId/reactions/:emoji     add my reaction (idempotent)   [rate-limited]
DELETE /messages/:messageId/reactions/:emoji     remove my reaction (idempotent)
```

`:emoji` is URL-encoded and validated against `REACTION_EMOJI`. Authorization reuses
`loadVisibleChannel` (you must be able to *see* the channel to react — invisible/restricted
channel ⇒ `404`, no existence leak, M9). Both return the message's updated
`reactions` summary (so the initiator reconciles) and publish the matching event. Per-session
rate limit (reactions are cheap but spammable): ~30 / 10 s, the `perSessionKey` pattern
already used by messages.

Reply adds **no endpoint** — `replyToMessageId` is an optional field on the existing WS
`message.send` and REST `POST /channels/:channelId/messages`.

### 5. Second-phase features get room, not detail

- **`@`-mentions** — will add a `mentions?: UserId[]` on the DTO (parsed server-side from
  content), a `mention.received` notification, and reuse M13's **user-scoped** bus. Reactions
  and replies neither block nor complicate it; the same page-enrichment seam extends to it.
- **Search** — Postgres full-text (`tsvector` on `messages.content`) + a search endpoint,
  independent of this work.

Neither had a dead affordance to remove at the time. Deferred without scaffolding (§35: don't
overbuild). **Both have since shipped** — mentions and full-text search are live on all
clients; see `docs/product/feature-parity.md`.

## Consequences

- **Migration 0008**: one new table (`message_reactions`) + one nullable self-FK column +
  one partial index on `messages`. Additive; no existing row changes shape.
- **`packages/types`**: `MessageReactionSummary`, `MessageReplyPreview`, and two optional
  fields on `Message` (`reactions`, `replyTo`). **`packages/config`**: `REACTION_EMOJI` +
  `REPLY_PREVIEW_MAX`. **`packages/protocol`**: `SendMessagePayload.replyToMessageId`,
  `MessageDTO` gains the two fields, two new server→client events (+ schemas + factories).
- **`packages/db`**: a new `message-reactions` repo (add/remove/aggregate), `messages` repo
  gains `replyToMessageId` on create + a batch `getReplyPreviews`, `mappers.toMessage` carries
  the reply id, `softDelete` also reaps reactions. A shared reply-preview builder both apps use.
- **`apps/api`**: two reaction endpoints + list/create enrichment for reactions & reply
  previews (a new `apps/api/src/lib/message-enrichment.ts` beside the attachments one).
- **`apps/realtime`**: `handleMessageSend` threads `replyToMessageId` and enriches the
  broadcast's reply preview. **No** gateway work for reactions.
- **Clients**: desktop wires three dead buttons (reaction palette popover, reply target,
  reaction pills, reply-preview line) and reserves virtualizer height for the new rows;
  mobile builds a long-press action sheet + pills + preview. `chat-store` gains a reply-target
  slot and optimistic-reaction handling; `connection.ts` handles the two reaction events.
- **Observation for realtime-backend (verify, out of M14 scope):** the WS `handleMessageSend`
  currently destructures only `{ channelId, content, nonce }` and **ignores
  `attachmentIds`** — attachments appear to link only on the REST path. M14's reply work adds
  the first post-create enrichment to that function, so whoever owns it should confirm whether
  attachment linking over WS is a parallel gap to close.

## Alternatives considered

1. **Denormalized reaction counters on `messages` (e.g. a `jsonb reactions` column).**
   Rejected: concurrent add/remove races the counter, `reactedByMe` still needs a per-user
   read, and every reaction rewrites the (large) message row. A skinny join table with a PK
   idempotency guard is simpler and correct under concurrency.
2. **A full unicode-emoji picker in the MVP.** Rejected for now: needs grapheme-safe
   validation/normalization and a picker dependency. The fixed palette ships the founder's ask
   (quick counted reactions) immediately; the `text` column means the picker is a
   no-migration follow-up.
3. **Reactions over a client→server WS event.** Rejected: edits and deletes already go over
   HTTP and fan out via the bus; reactions match that exactly and reuse the channel-scoped bus
   branch with zero new gateway code. A new WS verb would duplicate rate-limiting and
   validation that the HTTP layer already has.
4. **Full server-rendered reply preview (join author, embed avatar/attachments).** Rejected:
   an N+1 or a fat join on every page load. The client already has users; a 120-char text
   preview + `authorId` is enough to render the quote and is one batched query.
5. **A dedicated `message.replied` event / storing the reply as structured content.**
   Rejected: the reply is a property of the new message, so it belongs in `message.created`.
   A second event would double the round-trips and risk the preview and the message arriving
   out of order.
6. **`ON DELETE CASCADE` for `reply_to_message_id`.** Rejected: deleting a quoted message
   would silently delete every reply to it. `SET NULL` + a "deleted" preview stub preserves
   the conversation; soft-delete (the common path) keeps the row and renders the stub directly.
```
