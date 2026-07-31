# Social Layer — Implementation Plan (M13, ADR 0010)

> **Shipped — this is the plan as written, kept as a record.** Friendships, DMs and profiles (ADR 0010) are live in production on all three clients. It reads as
> forward-looking work orders because that is what it was; it is not a list of pending
> work. Current per-platform status lives in `docs/product/feature-parity.md`.

Reference: ADR 0010. Scope: friendships, DMs, profiles. Migration **0007**.
Rule: `docs/**` is written by product-architect; every code section below is owned by the
named agent on the named branch. Nothing here hits a §33 human-approval item.

## 1. Migration 0007 schema (owner: database)

`packages/db/migrations/0007_social_layer.sql` + matching `packages/db/src/schema.ts`.

```txt
-- enum: additive value. MUST be its own committed statement before any use
--       (Postgres forbids using a new enum value in the same txn that adds it).
ALTER TYPE friend_group_kind ADD VALUE 'dm';

-- friend_groups: DM uniqueness key (canonical member pair)
ALTER TABLE friend_groups ADD COLUMN dm_key text;                 -- null for server/group
CREATE UNIQUE INDEX friend_groups_dm_key_unique
  ON friend_groups(dm_key) WHERE kind = 'dm';

-- friend_group_members: per-member DM hide (never destroys the other side)
ALTER TABLE friend_group_members ADD COLUMN hidden_at timestamptz;  -- meaningful for dm rows only

-- users: profile bio + renewable friend code
ALTER TABLE users ADD COLUMN bio text;                            -- <=280, validated at API
ALTER TABLE users ADD COLUMN friend_code text;                    -- step 1: nullable
--   step 2 (data): backfill a unique base32 code for every existing row (generate+retry)
--   step 3: ALTER COLUMN friend_code SET NOT NULL; CREATE UNIQUE INDEX users_friend_code_unique

-- friendships: one row per unordered pair
CREATE TYPE friendship_status AS ENUM ('pending','accepted');
CREATE TABLE friendships (
  user_a       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       friendship_status NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz,
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)                                          -- canonical order + no self-friend
);
CREATE INDEX friendships_user_b_idx ON friendships(user_b);        -- reverse lookups (user_a is PK-leading)
```

Notes: `friend_code SET NOT NULL` is the only non-trivial step (3-phase: add nullable →
backfill → constrain). Enum `ADD VALUE` runs outside the wrapping txn. All else is
catalog-only / additive; no table rewrite.

## 2. Types & protocol (owner: product-architect) — ✅ landed (W1a, `feat/social-types`)

Final shipped names — this section is the import surface for W1b/W2+. Two naming
deviations from the first draft are called out inline.

**`packages/types/src/index.ts`**

```ts
export type DmId = GroupId;
export type FriendshipStatus = "pending" | "accepted";       // NOTE: drafted as FriendRequestStatus
export type FriendGroupKind = "server" | "group" | "dm";     // widened

// User gains two OPTIONAL fields (older fixtures keep compiling):
//   bio?: string | null   — mappers always emit it (null when unset); ≤280, escaped like messages
//   friendCode?: string   — populated ONLY on /users/me; never emitted for other users and never
//                           on the wire (protocol userSchema omits it and strips it on parse)

export interface Friendship {
  userA: UserId; userB: UserId;                               // canonical (userA < userB)
  status: FriendshipStatus; requestedBy: UserId;
  createdAt: string; updatedAt: string | null;
}
export interface Dm { id: DmId; streamId: ChannelId; participant: User; createdAt: string; }
export type ProfileFriendshipStatus = "none" | "incoming" | "outgoing" | "friends"; // named (was inline)
export interface UserProfile {
  user: User;                                                 // + bio
  friendship: ProfileFriendshipStatus;
  roles?: Role[];                                             // only when shared-server context
}
```

**`packages/protocol`** — four user-scoped server→client events, landed across
events.ts + schemas.ts + factories.ts:

```ts
// events.ts payloads
export type FriendRequestDTO = Friendship;                    // pending row presented as a request
export interface FriendRequestReceivedPayload { request: FriendRequestDTO; requester: User }
export interface FriendRequestAcceptedPayload { friendship: Friendship; friend: User }
export interface FriendRemovedPayload         { userId: UserId }
export interface DmCreatedPayload             { dm: Dm }

// union members
{ type: "friend.request_received"; payload: FriendRequestReceivedPayload }
{ type: "friend.request_accepted"; payload: FriendRequestAcceptedPayload }
{ type: "friend.removed";          payload: FriendRemovedPayload }
{ type: "dm.created";              payload: DmCreatedPayload }
```

Schemas: `friendshipSchema`, `dmSchema`, `friendRequestReceivedPayloadSchema`,
`friendRequestAcceptedPayloadSchema`, `friendRemovedPayloadSchema`,
`dmCreatedPayloadSchema`, with compile-time mirror asserts (`_assertFriendshipDTO`,
`_assertDmDTO`). `userSchema` gained optional `bio` and DELIBERATELY omits
`friendCode` — the codec strips it on parse (leak guard).
Factories: `SERVER_EVENT.friendRequestReceived / .friendRequestAccepted /
.friendRemoved / .dmCreated` + `serverEvent.*` constructors of the same names;
`serverToClientEventSchema` (which the mutation-bus codec validates against) includes
all four. W2/W3 build these events exclusively through `serverEvent.*` and route them
user-scoped on the bus (§3). Both client dispatchers (desktop + mobile `connection.ts`)
already carry silent no-op cases — W4/W5 replace those with real handling.

## 3. Realtime mutation bus — userId scope (owner: database, tiny)

**`packages/db/src/redis/mutation-bus.ts`**: add `userId?: string` to `RealtimeMutation`;
change the refine to *exactly one of* `channelId | groupId | userId`. Update
`packages/db/src/__tests__/mutation-bus.test.ts`. Small, unblocks Waves 2 & 3.

## 4. DB repositories & mappers (owner: database)

**`packages/db/src/repositories/friendships.ts`** (new):
`generateFriendCode()` (reuse invites' alphabet, len 8); `send(byUser, targetId)` with the
canonical-order + reverse-pending-auto-accept logic; `accept(id, byUser)`; `remove(a,b)`;
`listFriends(userId)` (+ user join); `listRequests(userId, direction)`;
`getFriendshipWith(viewer, target)`; `listAcceptedFriendIds(userId)` (for presence).

**`packages/db/src/repositories/dms.ts`** (new, mirrors `groupChatsRepo`):
`getOrCreate(a, b)` — canonical `dm_key`, one indexed lookup then transactional create
(friend_groups `kind='dm'` + 2 members + 1 hidden stream channel); `listForUser(userId)`
→ `Dm[]` with the *other* participant resolved and `hidden_at IS NULL` filtered;
`hide(groupId, userId)` / `unhide(...)`; `findByPair(a,b)`.

**`packages/db/src/repositories/users.ts`**: `updateProfile` accepts `bio`;
`findByFriendCode(code)`; `regenerateFriendCode(userId)`; `getProfile(viewerId, targetId,
groupId?)` returning `UserProfile` (role list gated on shared-server membership).
Mappers + seed users get `friendCode`/`bio`. Repo tests for every method (uniqueness,
canonical ordering, hide/unhide, code collision retry).

## 5. API modules (owner: realtime-backend) — branch `feat/social-api`

Register after `users` in `apps/api/src/app.ts`, passing `mutationBus`.

**`apps/api/src/modules/friends/index.ts`** (new):

```txt
GET    /friends                         → accepted friends + presence
GET    /friends/requests?direction=…    → pending incoming|outgoing
POST   /friends/requests                { friendCode } | { userId }   [rateLimit ~10/min, perSessionKey]
POST   /friends/requests/:id/accept     → addressee only; publishes friend.request_accepted (userId=requester)
DELETE /friends/requests/:id            → decline|cancel; publishes friend.removed (userId=other)
DELETE /friends/:userId                 → unfriend; publishes friend.removed (userId=other)
```

On send: publish `friend.request_received` (userId = addressee). On reverse-pending
auto-accept: publish `friend.request_accepted` instead.

**`apps/api/src/modules/dms/index.ts`** (new):

```txt
GET    /dms                             → dmsRepo.listForUser (hidden filtered)
POST   /dms            { userId }        → requires accepted friendship; getOrCreate (idempotent);
                                           on CREATE publish dm.created (userId=each participant)
DELETE /dms/:id                          → hide-for-self (sets hidden_at); no event needed
```

**`apps/api/src/modules/users/index.ts`** (extend): add `bio` to `PATCH /users/me`;
`GET /users/:id/profile?groupId=`; `POST /users/me/friend-code/regenerate` [rate-limited].

## 6. Gateway (owner: realtime-backend) — branch `feat/social-gateway`

**`apps/realtime/src/gateway.ts`**:

- In the `mutationBus.subscribe` handler add a third branch: `mutation.userId !== undefined`
  → forward `event` to `connectionsByUser.get(userId)`.
- `dm.created` special-case: for each of that user's live connections, `channelKinds.set(
  streamId,'text')` + `subscriptions.add(conn,[streamId])`, then send the event — the new
  DM receives messages immediately, no reconnect (reuses the ADR 0007 resync *add* primitive).
- `broadcastPresence` + handshake snapshot: audience becomes `union(listCoMemberUserIds,
  friendships.listAcceptedFriendIds)`.

## 7. Client core + desktop UI (owner: frontend-ui) — branch `feat/social-desktop`

TanStack Query hooks (`useFriends`, `useFriendRequests`, `useDms`, `useProfile`); socket
handlers for the four new events (invalidate/patch caches, subscribe DM stream on
`dm.created`). Components: **Home button atop `GroupRail`**; `HomeView` (Friends tabs
Online/All/Pending/Add + DM list); DM pane reuses `ChatView` keyed by `streamId`;
`ProfileCard` popover from member sidebar + message avatars; `AddFriendByCode` input;
own friend-code display + regenerate; bio editor in settings.

## 8. Mobile UI (owner: frontend-ui / mobile) — branch `feat/social-mobile`

Friends/DMs root tab; friends screen (segmented Friends/Pending/Add); DM conversation
reusing the message list; profile bottom sheet. Same query hooks/event handlers as §7 if
client-core is shared, else mirror.

## 9. Protocol events summary (typed, no magic strings — §24)

| Event | Scope | To | Payload |
|---|---|---|---|
| `friend.request_received` | userId | addressee | `{ request, requester }` |
| `friend.request_accepted` | userId | requester | `{ friendship, friend }` |
| `friend.removed` | userId | other party | `{ userId }` |
| `dm.created` | userId | both members | `{ dm }` |

## 10. Test plan (owner: qa-test; security reviews §12 items)

- **DB**: canonical ordering + `CHECK(user_a<user_b)`; friendship dedup (PK); reverse-pending
  auto-accept; `dm_key` uniqueness (one DM per pair); hide → absent from my list, present in
  theirs, history intact; unhide on inbound; friend-code collision retry + regenerate.
- **API**: only addressee accepts; decline vs cancel authz; DM requires friendship;
  `POST /dms` idempotency; profile role visibility (shared-server yes / stranger no /
  other-server no); request rate limit (~10/min); code-guessing rate limit; bio ≤280 + escape.
- **Realtime**: user-scoped fan-out reaches only the target's connections; `dm.created`
  makes the new stream deliver a message without reconnect; presence dot for a friend with
  no shared group.
- **E2E smoke**: add by code → accept → open DM → send/receive → close (hide) → reopen.

## 11. Wave partitioning

| Wave | Owner | Branch | Depends on | Est |
|---|---|---|---|---|
| **W1a Types+Protocol** | product-architect | `feat/social-types` | — | 0.5d |
| **W1b Migration+repos+mappers+seed+tests** | database | `feat/social-db` | W1a | 1.5d |
| **W1c Bus userId scope** | database | (folds into W1b) | W1a | 0.25d |
| **W2 API modules (friends/dms/profile) + rate limits** | realtime-backend | `feat/social-api` | W1 | 2d |
| **W3 Gateway (user fan-out + dm.created subscribe + presence)** | realtime-backend | `feat/social-gateway` | W1c, W2 event shapes | 1d |
| **W4 Client core + desktop UI** | frontend-ui | `feat/social-desktop` | W2 | 2.5d |
| **W5 Mobile UI** | frontend-ui / mobile | `feat/social-mobile` | W2 | 2d |
| **W6 QA + security review** | qa-test + security | `feat/social-qa` | W4, W5 | 1d |

Order: **W1 → W2 → {W3 ∥ W4 ∥ W5} → W6**. W3 can start once W1c + event shapes freeze
(parallel with W2's later half). W4 and W5 run in parallel (separate app trees). File
ownership is disjoint per wave (types/protocol vs db vs api vs gateway vs desktop vs mobile)
— no two agents touch the same file (§30).

## 12. Validation

- `pnpm typecheck` (mandatory — `packages/types` + `packages/protocol` change).
- `pnpm lint`; `pnpm test` (repo + api + realtime + protocol).
- Migration applies cleanly on a copy of a seeded DB; `friend_code` backfill leaves zero
  nulls before `SET NOT NULL`.
