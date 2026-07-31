# ADR 0017 — User blocking: symmetric enforcement, server-side hiding

**Status:** accepted
**Date:** 2026-07-27
**Milestone:** M18 (migration 0019)

## Context

M18 adds user blocking. The `friendship_status` enum has carried a comment since ADR 0010 §2
promising that blocking would arrive as "a separate directional `user_blocks` table, never a
third value" — this ADR cashes that in and, more importantly, decides the two questions that
actually determine whether a block WORKS:

1. **Is a block one-sided or symmetric?** The row is written by one person, but does it stop
   contact in one direction or both?
2. **Where does a blocked user's content get hidden — on the server, or on the client?**

Both matter because a block that holds on five of six surfaces is not a block. The founder-facing
promise is "I never see or hear from this person again", and the failure mode is not a crash —
it is a message that quietly gets through six months later.

The surfaces in play, all of which already exist in the codebase:

- DM sends over **two transports** (REST `POST /channels/:id/messages` and the WS gateway's
  `message.send`) — either one alone is a bypass;
- friend requests by **id**, by **friend code**, and the enumeration-hardened **by-username**
  route, whose contract is a uniform `200 { ok: true }`;
- **push notifications** (mention + the #94 all-messages channel push), dispatched by one shared
  function used by both transports;
- **message history and full-text search** in a shared server;
- **add-by-username to a group DM**, and (new in M18) the **group-DM invite link**;
- **DM calls** (start / accept / upgrade-to-group).

## Decision

### 1. Rows are directional; enforcement is symmetric

`user_blocks(blocker_id, blocked_id)` records who blocked whom. Every enforcement point asks the
**symmetric** question — "is there a row in EITHER direction?" — via a single shared primitive
(`userBlocksRepo.existsBetween` / `relatedIds`, wrapped by `apps/api/src/lib/blocks.ts`).

The rationale: a one-directional block would only MUTE the blocked user, not protect the blocker.
If A blocks B, then B must not be able to DM A either — otherwise B keeps talking and A just
cannot see it, which is the opposite of what a block is for.

Consequences:

- One error code, `BLOCKED` (HTTP 403 / realtime `error.raised`), with **identical copy in both
  directions**. Which side blocked is never disclosed (§28) — telling someone they have been
  blocked is precisely the information a block withholds.
- `GET /users/:id/profile` exposes `blocked` **one-directionally only**: "have I blocked them",
  never "have they blocked me". There is deliberately no API that answers the latter.
- `POST /friends/requests/by-username` refuses across a block with **`403 BLOCKED`** — the
  same neutral code and copy every other blocked interaction uses (`assertNotBlocked`: DM
  send, group-DM add, invite redeem), and the same answer the `userId` path on the very same
  action already gave. (Amended 2026-07-28: that route used to answer a uniform 200 to
  everything and the block rode along as a silent no-op; it now discloses whether a username
  exists, see ADR 0010 §6. A first attempt folded the block into `404 USER_NOT_FOUND` to make
  it look like an unknown handle; that was REVERSED the same day. Hiding a block behind
  "no such user" only works on someone who does not already know the account exists — and you
  generally block people you have interacted with, so a 404 for a handle they have seen reads
  as "they blocked me". It also made one action answer two different ways depending on which
  field the client sent.) The rule this ADR actually holds is that a block never reveals WHO
  blocked WHOM, and `BLOCKED` satisfies it: identical in both directions, and it discloses
  nothing a DM attempt would not disclose a moment later.

### 2. Blocking severs the friendship

Blocking deletes any accepted friendship or pending request and fans `friend.removed` — the
**same payload an ordinary unfriend produces** — to the other side, so their client cannot
distinguish a block from an unfriend. Unblocking does NOT restore the friendship: re-friending
requires a fresh, consent-bearing request.

### 3. Shared-server messages are hidden SERVER-SIDE, not client-side

**This is the load-bearing decision.** A blocked user's messages must disappear from shared
servers. The question was whether to implement that by (a) shipping the messages and letting the
client collapse them, or (b) never sending them.

We chose **(b), server-side**:

- **A client-side hide is a leak, not a hide.** The blocked user's text would still arrive on the
  machine of the person who blocked them — visible in devtools, in a memory dump, in a log, in a
  cached query, and in any future client that forgets the collapse branch. "Delivered but not
  rendered" is not a security property.
- **We already own both chokepoints.** History and search filter in SQL
  (`messages.listPage/search` take `excludeAuthorIds`, applied *before* the `limit + 1` slice so
  pages stay full and the keyset cursor stays disjoint — no duplicates, §22). The live fan-out
  filters per connection in the gateway, which already keeps a per-connection visibility set for
  the M9 role model — the block set is the same shape of state.
- **Cost is bounded.** One extra indexed query per history/search read, and an in-memory `Set`
  miss per broadcast recipient (empty for almost every connection).

What is deliberately NOT filtered: `message.deleted`, reaction deltas, embed updates, and pins.
None carries the blocked user's text, and dropping a `deleted` for a message the reader never
received would only desynchronise caches.

One consequence worth stating: a reply that QUOTES a blocked user would leak their words through
someone else's message. Reply previews from blocked authors are therefore redacted into the
existing "deleted" stub, so clients need no new rendering branch.

### 4. The realtime half uses the M9-4 resync pattern, not delta patching

Each connection carries `blockedUserIds`, seeded from the DB at handshake. On a block change the
API publishes a thin user-scoped `user.blocks_updated`, and the gateway **re-derives the whole set
from the DB** rather than patching the delta in. Re-deriving is idempotent, self-heals a missed
event, and cannot drift — the same reasoning as the M9-4 channel-visibility resync. The filter
starts and stops applying mid-session with no reconnect.

### 5. Blocking does not gate joining a SERVER; it does gate a group DM

A block is a personal-contact tool: it does not stop either party joining a public-ish
server, where the per-surface guards (hidden messages, no pushes) do the work. A **group DM** is a
private space, so both ways in are gated:

- add-by-username checks the adder AND every existing member against the target;
- the new group-DM invite link refuses redemption when the redeemer and the link's **creator** —
  the person who actually handed it out — have blocked each other, checked inside the same locked
  transaction as the membership insert (so a block committed before the read is honoured).

## Alternatives considered

- **A third `friendship_status` value ("blocked").** Rejected in ADR 0010 and still wrong: blocks
  are directional and can coexist with no prior relationship, so they do not fit a symmetric
  friendship row.
- **Client-side collapse.** Rejected — see §3. Cheaper, but it does not actually withhold anything.
- **A single choke point for all enforcement.** Attractive, but no such point exists: a block must
  hold on the WRITE path (a DM send, a call, an invite redeem) and the READ path (history, search,
  push) and the LIVE path (fan-out). The shared helpers in `lib/blocks.ts` give one *rule* in one
  place, applied at each boundary.
- **Refusing add-by-username with a 403.** Rejected — it would break that route's uniform-response
  contract and leak both existence and block state.

## Consequences

- Migration 0019 is additive: `user_blocks` (+ `channel_categories`, `moderation_actions`, and four
  nullable columns). No existing column changes meaning; production data is untouched.
- A new `BLOCKED` code exists on both the HTTP (`ApiErrorCode`) and realtime (`RealtimeErrorCode`)
  contracts.
- Every read path that returns messages must pass `excludeAuthorIds`. A future message-returning
  endpoint that forgets it is a silent block bypass — this is the main maintenance hazard, and it
  is why the coverage test (`apps/api/src/__tests__/blocks.int.test.ts`) asserts one case per
  surface rather than testing the primitive in isolation.
- The UI wave must add: a block/unblock action on the profile card, a blocked-users settings list
  (`GET /users/me/blocks`), and handling for `user.blocks_updated` (refetch the affected channels
  so hidden history appears/disappears). The clients currently no-op that event.
