# ADR 0019 — Private annotations, the nickname duality, timeout, and ignore-vs-block

**Status:** accepted
**Date:** 2026-07-27
**Milestone:** member context menu (migration 0020)

## Context

The user right-click menu had eleven actions with a backend and five without: **note**, **friend
nickname**, **server nickname**, **timeout**, and **ignore**. They look like five small CRUD jobs.
They are not — four of the five turn on a question the schema cannot answer on its own:

1. A note is a *secret*. Who may read it, and how is that guaranteed rather than intended?
2. Demli now has **two different things called "nickname"**. Why two, and what stops one
   becoming the other?
3. A timeout is *enforcement*. A `timed_out_until` column that nothing checks is not a mute; it is
   a lie in a database (§35). Which paths must it cut, and when does it expire?
4. An ignore is *almost* a block. ADR 0017 already decided how a block behaves, including the
   load-bearing "hide server-side, never client-side". Does an ignore inherit that, or not?

## Decision

### 1. Notes are single-reader, and the schema is shaped to keep them that way

`user_notes(viewer_id, target_id, body, …)`, PK on the pair, ≤256 chars. **Only `viewer_id` may
read a row**, and that is enforced structurally rather than by discipline:

- The repository takes `viewerId` **first, on every method**, and filters on it. There is no
  `listForTarget`, no `findByTarget`, no "notes about this user" query — a caller cannot read
  someone else's note because no method will return one.
- The table has **no reverse index on `target_id`**, deliberately, unlike `user_blocks` which has
  one. An index on the target *is* the access path "everything ever written about this person".
  The only read is by the full PK, so omitting it costs nothing and removes the tool.
- Exactly **one endpoint** reads a note (`GET /users/:id/note`, always scoped to the session's
  user). No profile projection, roster query, realtime payload, moderation surface or push carries
  it.
- `apps/api/src/__tests__/user-notes.int.test.ts` drives the *target's own token* against every
  plausible read (their profile, the member roster, the moderation log, the notes endpoint itself)
  and asserts nothing comes back. A privacy rule with no test is a promise.

This is also why notes and nicknames are **two tables despite an identical key** (§2 below). They
share a shape but not a blast radius: keeping them apart makes "nothing outside the note endpoint
selects from `user_notes`" a grep-checkable invariant instead of a column-selection rule that every
future join has to remember.

There is deliberately **no realtime event for a note**. It renders in one place, which fetches it
on open. Putting private text on a fan-out bus would buy nothing, and the narrower the path a
secret travels, the fewer places can leak it.

### 2. Two nicknames, two audiences, two tables

This is the duality the ADR exists to pin down, because collapsing it is a privacy bug that would
look like a deduplication win:

| | private nickname | server nickname |
|---|---|---|
| storage | `user_nicknames(viewer_id, target_id, nickname)` | `friend_group_members.nickname` |
| audience | **only the viewer** | **everyone in that server** |
| scope | global, across all surfaces | one server |
| who may set | anyone, for anyone | yourself freely; others need a permission |
| realtime | `user.nickname_updated` (USER-scoped, to the viewer's own devices) | `member.nickname_updated` (GROUP-scoped) |

They are the same word for two different facts — "what *I* call you" and "what *this server* calls
you". Merging them into one column would publish one user's private label to a whole server.

**Name resolution order, for every client:** private nickname → server nickname → `displayName`.

Resolution is **client-side**. `GET /users/me/nicknames` returns the viewer's whole private map
once, and the client applies it locally. That is why no roster, message page or DM list joins
`user_nicknames`: a private label never has to travel attached to a payload where it could be
fanned out to the wrong person. (A friend-group app's map is small; if it ever is not, it gains a
cursor like every other list.)

**`MANAGE_NICKNAMES` is a new permission bit (`1 << 5`), not a reuse.** Setting your *own* server
nickname needs no bit at all — that is self-expression, not moderation. Changing
*someone else's* needs owner ∨ `MANAGE_NICKNAMES`, plus the standard owner immunity. The alternative was gating it behind `KICK_MEMBERS`, the only other member-scoped bit,
which would force an owner to grant the power to **remove people** in order to delegate the power
to fix a typo. A cosmetic, fully reversible action must not require a destructive permission. This
is one more entry in the existing `PERMISSIONS` record — not a new mechanism: `ALL_PERMISSIONS`
picks it up automatically and the roles module's "unknown bit" refine already covers it.

### 3. Timeout is enforcement first, storage second

State is one nullable column, `friend_group_members.timed_out_until`. Everything that matters is
where it is *checked*:

| path | gate |
|---|---|
| send a message (REST) | `POST /channels/:id/messages`, before slowmode and before the write |
| send a message (WS) | gateway `message.send`, same position, same copy |
| add a reaction | `PUT /messages/:id/reactions/:emoji` |
| join voice | `POST /media/token` |

**Both transports, always.** The desktop client sends over the socket and the mobile client over
HTTP; a mute enforced on one of them is a mute enforced on neither. The block gate is duplicated
across the same two paths for the same reason, and the timeout gate sits beside it.

The voice gate is on the **token mint**, not on a client-side check: the SFU only admits a
participant holding a token signed by the API, so refusing to mint one refuses the join outright. A
client that skips the check simply has nothing to connect with. Same reasoning as the moderator
voice-disconnect, which relies on the server-side force-remove rather than on the client leaving
politely.

Deliberately **not** cut: reading, removing your *own* reaction, leaving voice, deleting your own
message. A timeout silences someone; it does not trap them with what they already said.

**Expiry is evaluated at query time — no cron, no sweeper.** `isTimedOut()` compares the stored
instant to the clock on every check, so a mute stops applying the moment it lapses. A scheduled job
would add moving parts to buy nothing: there is no side effect to run at the expiry instant,
because the state *is* the comparison. It also cannot be missed across a restart and leaves no
window in which a lapsed timeout is still enforced.

`isTimedOut` lives in `@demli/types`, beside `hasPermission`, because the API and the gateway are
separate deployables that must agree. A copy in each would be two rules that merely look alike.

**Cost: zero extra queries on the hot path.** `channels.findWithMembership` already reads the
membership row to resolve access, so `timed_out_until` rides along on a join that was happening
anyway. The gate is a clock comparison, not a lookup.

**Permission: owner ∨ `KICK_MEMBERS`** — the same bit as kick, reused. A timeout is strictly *less*
severe than a kick (temporary, reversible, keeps membership and history), so gating it behind the
kick bit grants no new authority: everyone who can time someone out could already have removed
them. A separate bit would only express "may mute but may not kick", a distinction this MVP has no
role hierarchy to make sense of (ADR 0007). Note this is the mirror image of the `MANAGE_NICKNAMES`
reasoning — reuse where the new action is *weaker* than the existing bit, a new bit where it is
*orthogonal and weaker*.

The audit log gains two actions, `timeout` and `timeout_remove`, plus a nullable
`moderation_actions.expires_at`. Two values rather than one because "who muted them" and "who let
them back in" are different accountability questions, and a log that answers only the first cannot
explain why a 24-hour timeout ended after ten minutes. `expires_at` because a log line reading
"timed out" with no duration is nearly useless.

`member.timeout_updated` is GROUP-scoped, which already includes the target — a timeout leaves
membership intact, so the ordinary group audience reaches their devices. That is why it needs no
separate user-scoped notice, unlike a kick (where membership is gone by the time the event lands).

### 4. Ignore is not a quiet block — and it hides content client-side

This is the decision that most needs writing down, because it **departs from ADR 0017 §3 on
purpose**.

| | block (ADR 0017) | ignore (this ADR) |
|---|---|---|
| direction | symmetric — either row cuts both ways | one-directional |
| friendship | **severed**, fans `friend.removed` | untouched |
| their sends | refused, `403 BLOCKED` | succeed normally |
| history | **hidden server-side**, filtered in SQL | delivered; **collapsed client-side** |
| notifications | dropped server-side | dropped server-side |
| detectable by the other side | yes (sends start failing) | **no — nothing changes for them** |

An ignore cuts **no write path**. Nothing consults `user_ignores` before a send. The ignored user's
messages send, persist and deliver exactly as before, and they receive no event, no error and no
flag on any profile they can read. An ignore the target can notice is just a rude block.

The repository reflects this: no `existsBetween` (a symmetric primitive here would silently make an
ignore behave like a half-block), no "who ignores me" method, and no reverse index to make one
cheap. That question is what the feature exists to leave unanswerable.

**Notifications are filtered server-side. Message content is not.** The split is a threat-model
difference, not an inconsistency:

- A **push must** be server-filtered. It is delivered by the server to a device's OS, so a client
  cannot suppress a notification it never sees. This is the half that makes the feature felt, and
  it includes the mention ping — otherwise an ignored user could still buzz someone's phone by
  typing their `<@id>`, and "I stopped being notified by them" would be false in the case that
  matters most.
- **Content is collapsed client-side**, which ADR 0017 explicitly rejected for blocks. That
  rejection was right *there*: a block promises "this person cannot reach me", a security property,
  so delivering their text at all is the leak. An ignore promises "do not put this person in front
  of me right now" — about attention, not access. The ignorer explicitly wants to be able to expand
  a collapsed row and read it; replies quoting an ignored user must still render in context; and
  un-ignoring should restore the conversation instantly rather than forcing a refetch of history
  the server refused to send. Server-side hiding would break all three to defend against a threat
  that is not present, because the ignorer is not hiding the content from themselves.

`user.ignores_updated` is USER-scoped to the ignorer only, a thin resync mirroring
`user.blocks_updated`. Nothing was hidden server-side, so there is no history to restore on
un-ignore — the client just stops collapsing.

## Alternatives considered

- **One `user_annotations` table holding both note and private nickname.** Identical key, one
  query to hydrate a profile card. Rejected: the note is a single-reader secret and the nickname
  feeds many render paths, so a shared row makes the privacy rule a per-query column discipline
  instead of a table-level boundary. §1's grep-checkable invariant is worth one extra table.
- **One nickname, per-server only (no private nickname).** Simpler, but it is the wrong product:
  the whole point of a private nickname is that it follows the person across every surface and is
  invisible to them.
- **Gating server nicknames behind `KICK_MEMBERS`.** No new bit, but it inverts severity — see §2.
- **A `timeouts` table with its own rows.** Rejected: a timeout is a single-valued property of a
  membership, so a column on `friend_group_members` is the honest model, and it is what makes the
  zero-extra-query gate possible.
- **A cron/sweeper to clear expired timeouts.** Rejected — §3.
- **Making ignore a symmetric, block-like mute.** Rejected: then it is just a block with worse
  copy, and the founder asked for something *softer*.
- **Hiding ignored users' messages server-side, for consistency with ADR 0017.** Rejected — §4.
  Consistency with a rule is worth less than consistency with the reason for the rule.

## Consequences

- **Migration 0020 is strictly additive**: three new tables (`user_notes`, `user_nicknames`,
  `user_ignores`) and three nullable columns (`friend_group_members.nickname`,
  `friend_group_members.timed_out_until`, `moderation_actions.expires_at`). No existing column
  changes type, nullability or meaning; every pre-0020 row reads correctly (`NULL` timeout *is*
  "not timed out"). The two new `moderation_actions.action` values need no SQL at all — the column
  is plain `text` with a type-level enum, exactly the flexibility 0019 chose it for.
- A new `TIMED_OUT` code exists on **both** the HTTP (`ApiErrorCode`) and realtime
  (`RealtimeErrorCode`) contracts, so the same refusal reads the same on either transport.
- `PERMISSIONS` gains a sixth bit. Existing roles are unaffected (the bit is simply unset), so no
  member gains or loses anything on deploy.
- **The main maintenance hazard is the timeout gate**, and it is the mirror of ADR 0017's: a future
  write path that lets a timed-out member speak is a silent bypass. That is why the integration
  tests assert one case *per path* (message REST, message WS, reaction, voice token) rather than
  testing `isTimedOut` in isolation.
- The UI wave must add: the five context-menu actions; name resolution in the documented order;
  client-side collapse for ignored authors with an expand affordance; a timeout indicator driven by
  `member.timeout_updated`; and settings lists for ignores and private nicknames. Clients currently
  no-op the four new events.
