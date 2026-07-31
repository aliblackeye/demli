# ADR 0010 — Social Layer (M13): Friendships, DMs, Profiles

**Status:** accepted — shipped; friends, DMs and profiles are live on all clients
**Date:** 2026-07-09

## Context

Founder asks for M13: talk to one person without creating a group. Concretely:

- Add a friend by **friend code** or by **seeing them in a server/group** and sending
  a request; an area to **accept / decline** incoming requests.
- Once friends, **DM** each other (no group required).
- Click a person → **profile**: bio + photo (self-editable), plus their **roles in the
  current server** when viewed in a server context.

Today the domain has `User`, `friend_groups` (`kind = 'server' | 'group'`, ADR 0005),
per-server `Role`/visibility (ADR 0007), and media/avatar via Supabase Storage
(ADR 0008). There is no concept of a relationship between two users, no DM, and the
profile is only `{ username, displayName, avatarUrl }`.

Fixed constraints going in (all verified in code):

- The message + realtime pipeline is **channel-scoped**. `channels.listForUser` and
  `groups.listCoMemberUserIds` are **kind-agnostic** — they join `channels`/members by
  `user_id` with no filter on `friend_groups.kind`. So any `friend_groups` row a user
  belongs to, with a channel, automatically flows into the gateway's handshake
  subscription set (`visibleChannelKinds`) and presence audience. This is the load-
  bearing fact behind the DM decision below.
- The mutation bus (`packages/db/redis/mutation-bus.ts`) is **channel- or group-scoped**
  (`RealtimeMutation` sets exactly one of `channelId` / `groupId`). Friend/DM events are
  **per-user**, which the bus cannot express yet. The gateway already keeps a
  `connectionsByUser` index — the missing piece is a `userId` scope on the bus.
- CLAUDE.md §5/§35: no sprawling relationship graph in MVP. Minimal but growable.
- Migrations run through 0006; this work is **migration 0007**.

Nothing here touches a §33 human-approval item (no app name / auth method / LiveKit /
framework / DB-provider change) or a §35 non-negotiable (no media over WS; friendships
are a minimal two-state relation, not a permission system).

## Decision

### 1. DM = `friend_groups.kind = 'dm'` (reuse, do not fork)

Extend the `friend_group_kind` enum with a third value `'dm'`. A **DM is a
`friend_groups` row with `kind='dm'`, exactly two members, owning exactly one hidden
text channel** (its stream) — created in one transaction, mirroring `groupChatsRepo.create`
(ADR 0005). Because the message/realtime pipeline is kind-agnostic, a DM reuses ~90% of
the group-chat infra with **zero** new message table, WS route, pagination, or nonce
logic. `streamId` is the DM's channel key, exactly as for groups.

Invariants attached to the kind:

- **Uniqueness — one DM per unordered pair.** `friend_groups` gains a nullable
  `dm_key text` set at creation to `least(a,b) || ':' || greatest(a,b)` of the two member
  ids, with a **partial unique index** `WHERE kind='dm'`. `POST /dms {userId}` is
  idempotent: one indexed lookup on `dm_key` returns the existing DM or creates it.
  > **W1b uygulama sapması (2026-07-15):** index predicate'i `WHERE dm_key IS NOT NULL`
  > olarak kuruldu — Drizzle migrator tüm migration'ları TEK transaction'da koştuğu
  > için taze eklenen `'dm'` enum değeri aynı tx'te kullanılamaz (PG "unsafe use of
  > new value"). `dm_key` yalnız `kind='dm'` satırlarında set edildiğinden predicate
  > eşdeğerdir; invariant'ı repo katmanı korur.
- **Not invitable.** The invites surface is kind-gated; DMs (like groups) have no invite
  editor and reject invite creation.
- **No add/remove member.** Membership is fixed at 2 by construction. The group-chat
  member endpoints are kind-filtered to `'group'` (`groupChats.findById` → null for DMs),
  so they already reject DMs; the DM surface never exposes add/remove.
- **"Delete" = hide-for-self, never destroy.** `friend_group_members` gains a nullable
  `hidden_at` (meaningful for DM rows only). Closing a DM sets the caller's `hidden_at`;
  the DM list filters `hidden_at IS NULL`. **The counterpart's row is untouched → their
  copy and full history remain.** A new inbound message, or the caller re-opening via the
  profile "Message" action, clears `hidden_at` (the DM re-surfaces). No history is ever
  deleted by closing.
- **Lifecycle independent of friendship.** Once a DM exists it keeps working even if the
  users later unfriend (matches user expectation; avoids destroying shared history). DM
  creation, however, **requires an accepted friendship** (§2).

DMs never appear in `/groups` (server-only) or `/group-chats` (group-only); they get
their own `/dms` surface, mirroring ADR 0005's clean list separation.

Client-facing shape is a purpose-built DTO, not `Group` (a DM's identity is the *other
person*, not a name/icon):

```ts
interface Dm { id: GroupId; streamId: ChannelId; participant: User; createdAt: string; }
```

`participant` is the **other** member, resolved by the server relative to the caller.

### 2. Friendships

New table `friendships`, one row per unordered pair:

```txt
friendships   user_a uuid, user_b uuid          -- canonical: user_a = LEAST, user_b = GREATEST
              status  enum('pending','accepted')
              requested_by uuid                  -- which side sent it (incoming vs outgoing, accept guard)
              created_at, updated_at
              PK (user_a, user_b)
              CHECK (user_a < user_b)            -- forbids self-friend, forces canonical order
              FK user_a, user_b → users ON DELETE CASCADE
```

Postgres `uuid` has a total order, so `LEAST/GREATEST` and `<` work directly. The pair is
unique regardless of who requested; `requested_by` distinguishes direction.

**Friend code.** `users` gains `friend_code text NOT NULL UNIQUE`. 8 chars over the
unambiguous base32 alphabet already used for invites (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`,
no 0/O/1/I/L) → 30⁸ ≈ 6.5×10¹¹ combinations. Stored uppercase, looked up case-insensitively,
displayed grouped (`XXXX-XXXX`). **Renewable**: `POST /users/me/friend-code/regenerate`
mints a new unique code and invalidates the old one.

**Request flows** (`POST /friends/requests`, body is one of):

- `{ friendCode }` — resolve to a user, then create/accept as below.
- `{ userId }` — for "saw them in a server/member list, sent a request". A request is
  harmless (target must accept), so a raw userId input is acceptable.

Guards: cannot friend yourself; **already accepted** → 409; **duplicate pending from me**
→ 409 (idempotent no-op); **reverse pending exists (they already asked me)** → treat this
call as acceptance (both consented) and go straight to `accepted`.

**Accept / decline / remove area:**

```txt
GET    /friends                          accepted friends (+ user + presence)
GET    /friends/requests?direction=…     pending incoming | outgoing
POST   /friends/requests                 send (by code or userId)      [rate-limited]
POST   /friends/requests/:id/accept      addressee only → status accepted
DELETE /friends/requests/:id             decline (addressee) or cancel (requester)
DELETE /friends/:userId                  unfriend (removes accepted row)
```

Only the **addressee** (not `requested_by`) may accept. Accepting does **not** auto-create
a DM — the friend appears in the list, and the profile "Message" button calls `POST /dms`
(idempotent) so we never create empty DMs for relationships that never chat.

**Blocking was deferred** at the time (MVP scope) and has since shipped — see **ADR 0017**,
which took exactly the reserved shape: a
**separate directional `user_blocks (blocker_id, blocked_id)` table** — a block is
one-way and independent of the symmetric friendship row, so we do **not** overload
`friendships.status` with `'blocked'`.

### 3. Profile

`users` gains `bio text` (≤ 280 chars, nullable). Avatar already exists (`avatarUrl`);
avatar image upload reuses the ADR 0008 Storage path. `PATCH /users/me` is extended to
accept `bio` (alongside the existing `displayName`, `avatarUrl`).

**Context-aware profile card**, `GET /users/:id/profile?groupId=<optional>`:

```ts
interface UserProfile {
  user: User;                 // id, username, displayName, avatarUrl, bio, createdAt
  friendship: "none" | "incoming" | "outgoing" | "friends";   // relative to viewer
  roles?: Role[];             // ONLY when groupId given AND both are members of that server
}
```

Role visibility rule: `roles` is returned **only** when `groupId` names a `kind='server'`
space that **both** the viewer and the target belong to. Viewing a stranger, or someone in
a server you are not in, never leaks that server's roles. The card carries the actions
("Add friend" / "Cancel" / "Accept" / "Message" — Message enabled iff `friends`). `bio` is
escaped like message content (§28); no HTML/markdown injection.

`GET /users/:id` stays as-is for back-compat; the profile endpoint is additive.

### 4. Realtime — user-scoped mutation bus

Add a **third, mutually-exclusive scope** `userId` to `RealtimeMutation` (`channelId` |
`groupId` | `userId`; the zod refine becomes "exactly one of three"). On a `userId`-scoped
mutation the gateway forwards `event` to `connectionsByUser.get(userId)` — the index
**already exists**; no new bookkeeping. New server→client events (all user-scoped):

```txt
friend.request_received   → addressee     { request, requester: User }
friend.request_accepted   → requester     { friendship, friend: User }
friend.removed            → other party   { userId }        (covers decline / cancel / unfriend)
dm.created                → both members   { dm: Dm }
```

`dm.created` also **needs the recipient to start receiving the new stream channel**
without reconnecting. The gateway handles it with a light "subscribe to new channel" step
(same primitive as the ADR 0007 resync *add* path): on `dm.created` it sets `streamId` on
each of that user's live connections' `channelKinds` and calls `subscriptions.add`, then
forwards the event. Friend/`friend.removed` events need no resync (no channel visibility
change).

**Presence for friends.** Today `broadcastPresence` targets `listCoMemberUserIds`
(shares a group). Friends with an existing DM are already co-members, but freshly-accepted
friends without a DM are not. Extend the presence audience (and the handshake snapshot) to
`union(coMembers, acceptedFriendIds)` so the friends list shows accurate online/idle/offline.

### 5. UI

- **Desktop.** A **Home button at the top of `GroupRail`** (above the server
  avatars). Home = a left column with Friends (tabs **Online / All / Pending / Add Friend**)
  and a **DM list**; the main pane shows the selected DM (`ChatView` keyed by `streamId`,
  reused unchanged) or the friends table. A **profile popover** opens from a member-sidebar
  entry or a message avatar (avatar, name, username, bio, server roles if in a server,
  actions). "Add Friend" = friend-code input + the action on profile cards.
- **Mobile (Expo RN, ADR 0004).** A **Friends/DMs tab** in the root tab bar; a friends
  screen with a segmented control (Friends / Pending / Add); a DM conversation screen
  reusing the message list; profile as a bottom sheet.

### 6. Security / abuse (§28)

- **Request spam:** per-user session-keyed rate limit on `POST /friends/requests`
  (~10/min), reusing the `config.rateLimit` + `perSessionKey` pattern from messages.
- **Code guessing:** 8-char base32 (≈6.5×10¹¹ space) + rate limit on request-by-code +
  renewable codes. A correct guess only yields a *pending* request the target must accept
  → low harm. Unknown code → generic `NOT_FOUND`.
- **Username enumeration (SUPERSEDED 2026-07-28 — founder directive).** `POST
  /friends/requests/by-username` (#111, the friend-code replacement) originally answered a
  uniform `200 { ok: true }` whether or not the username existed, so it could not be used
  to probe which handles are registered. **It now answers `404 USER_NOT_FOUND`.**
  - *Why the reversal:* the entire cost of the uniform response was paid by ordinary users.
    Someone who mistyped a handle was told "sent — if that user exists" and then waited for
    a request that was never created, with no way to tell a typo from an unanswered
    request. Once the product had real users that became direct support load, not a
    hypothetical. The asset being protected is also weak: a username is a PUBLIC handle,
    visible on every message, member list and mention the moment you share one server, so
    the silence bought nothing an attacker could not get for free.
  - *What now carries the protection:* the **per-session rate limit of 10 requests per 5
    minutes is the primary and only enumeration control.** It is no longer a secondary
    measure. A scraper needs its own authenticated session and roughly 35 hours to test
    5,000 guesses. Do not remove it, raise `max`, or shorten `timeWindow` without replacing
    it with something at least as strong.
  - *What is still not disclosed:* relationship state — `already_pending` / `already_friends`
    answer the same 200 as a fresh send, so the route never reports a relationship the caller
    has not been let into. A soft-deleted account answers `USER_NOT_FOUND` because it really
    is unreachable by username; a **block answers `403 BLOCKED`**, the neutral code every
    other blocked interaction returns (ADR 0017 §1). Folding the block into `USER_NOT_FOUND`
    was tried on 2026-07-28 and reversed the same day: it hides nothing from anyone who
    already knows the handle exists, and it made the `userId` and `username` paths of one
    action disagree.
- **Structural guarantees:** `friendships` PK dedups spam rows; DM `kind` + 2-member
  construction + `dm_key` unique make DMs un-invitable and non-duplicable.
- **No role leak:** profile roles gated on shared-server membership (§3).

## Consequences

- Migration 0007: `friendships` (+ `dm_key`, `hidden_at`, `friend_code`, `bio` columns) and
  the `friend_group_kind += 'dm'` enum value. Three additive columns + one new table + one
  enum value; no existing row changes shape.
- New domain types (`Friendship`, `FriendshipStatus`, `Dm`, `UserProfile`,
  `ProfileFriendshipStatus`, `User.bio?`, `User.friendCode?` (me-only, never on the wire),
  `FriendGroupKind` widened) in `packages/types`; four events + a `userId` bus scope in
  `packages/protocol` / `packages/db`. Landed W1a shapes: implementation plan §2.
- New API modules `friends`, `dms`, and a richer `users` profile; the gateway gains a
  user-scoped fan-out + a dm.created subscribe step + a friends-inclusive presence audience.
- The DM path is the one genuinely new realtime moving part; it needs dedicated tests.
- Growth room: block (`user_blocks`), server-member DM (drop the friendship precondition),
  group DMs (relax the 2-member rule to `kind='group'`) all extend, not replace, this.

## Alternatives considered

1. **Separate `direct_messages` table + parallel message path.** Rejected: duplicates the
   channel-scoped pipeline (pagination, nonce, WS routing, mutation bus) — the exact drift
   ADR 0005 exists to prevent. `kind='dm'` gets it all for free.
2. **DM as `kind='group'` with 2 members.** Rejected: DMs would contaminate the
   `/group-chats` list, inherit the group add/remove endpoints, and lose the natural place
   to hang the 2-member / uniqueness / not-invitable invariants. A distinct `kind` keeps
   the lists and invariants clean at the cost of one enum value.
3. **`friendships.status` includes `'blocked'`.** Rejected: a block is directional, a
   friendship is symmetric; overloading the row muddles both. A separate directional
   `user_blocks` table (deferred) is cleaner.
4. **Auto-create the DM on friend-accept.** Rejected: fills the DM list with empty
   conversations for relationships that never chat. Lazy idempotent `POST /dms` keeps the
   list meaningful.
5. **A fourth `RealtimeMutation` shape / a second bus for user events.** Rejected: a third
   mutually-exclusive `userId` field reuses the existing bus, codec, and `connectionsByUser`
   index with one branch — no new channel, no new subscriber.
6. **Reuse `broadcastPresence`'s co-member audience unchanged.** Rejected: accepted friends
   with no shared group/DM would show a stale presence dot; the `union(coMembers, friends)`
   audience is the minimal correct fix.
