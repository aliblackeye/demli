# ADR 0020 — Presence is Per-Connection, Derived from Live Sockets

**Status:** accepted — gateway store, API reader, and the derivation rule shipped on
`feat/presence-per-connection`.
**Date:** 2026-07-29

## Context

Presence was stored as **one key per user**: `presence:status:{userId}`, a Redis STRING with
no TTL, written by whichever connection last sent `presence.update` and deleted only when
that user's **last** connection disconnected.

The decision that feeds it, however, is made **per device**. The desktop's inactivity timer
watches *that machine's* input and flips to `idle` after 5 minutes; it knows nothing about a
phone. So:

1. Desktop goes idle → writes `idle` to the single per-user key.
2. Desktop closes (app quit, machine sleeps). The phone is still connected, so the key is
   **not** deleted — and it has no TTL.
3. The user is active on their phone. The phone does not reconnect, so it never re-asserts
   anything. Everyone sees **idle**, indefinitely.

The founder hit exactly this on 2026-07-28: *"bilgisayarda aktifim hala dışarıda gözüküyorum,
ama durum ayarla kısmında çevrimiçi seçili"* — their own picker read "Çevrimiçi" while friends
saw the amber dot, with nothing in any log, because every component behaved as written.

A same-day patch (`574537c`) made **every** client re-assert its status on connect instead of
skipping the frame when the status was plain `online`. That closes the symptom on reconnect,
and it stays — but it does not fix the model: with two live devices, one idle and one active,
there was still no structure that could produce the right answer. The last writer won, and a
device that had gone away could be the last writer.

The neighbouring per-connection facts had already been modelled correctly — `platform` (#47)
and `appstate` (#110) are both hashes keyed by connection id that mirror the conns SET. Status
was the one holdout.

## Decision

**Store status per connection; derive the account's status from the live connections.**

`presence:connstatus:{userId}` — a Redis HASH of `connectionId → declared status`, seeded
`"online"` on connect, `hdel`'d on disconnect, deleted wholesale when the last socket leaves.
It mirrors the conns SET exactly, like `platform` and `appstate`. Nothing outlives the socket
that reported it.

`presence.update` keeps its wire shape; only its **interpretation** changes — the frame now
means *"this connection declares X"*, recorded against the authenticated socket's own id. Old
clients are unaffected (see Compatibility).

### The derivation rule

`derivePresenceStatus` in `packages/types` (next to `publicPresenceStatus`, dependency-free,
shared by the gateway store and the API's `RedisPresenceReader` so the two cannot drift):

| Priority | Status      | Rule                                          |
| -------- | ----------- | --------------------------------------------- |
| 1        | `invisible` | ANY live connection declares it               |
| 2        | `dnd`       | ANY live connection declares it               |
| 3        | `online`    | ANY live connection declares it               |
| 4        | `idle`      | only when EVERY live connection declares it   |
| —        | `offline`   | no live connections at all (decided upstream) |

Empty bag or unrecognized values ⇒ `online` (a connection that never declared a status is
available — the pre-ADR default). `offline` is never derivable: it means "no sockets".

### Why `dnd` and `invisible` rank above availability

The split is **availability vs intent**.

`online`/`idle` are *availability*, and availability is genuinely per-device — the whole point
above. `dnd`/`invisible` are *intent*: a deliberate declaration about the **human**, not the
machine. If you set Do Not Disturb on your phone because you are in a meeting, your desktop
must not ring. So any live device declaring intent wins for the account. This is the founder's
existing rule *"manuel seçim otomatiği ezer"* (a manual pick beats the automatic one), applied
one level up.

`invisible` outranks `dnd` because unmasking is the worst failure mode available here. If
derivation answered "online" merely because a second device connected, a user who deliberately
asked to be hidden would be revealed — silently, and with no way for them to notice. Ranking
it first means a plain-`online` phone can never expose an invisible desktop.

This also fixes a second stomping bug for free. Since `574537c`, every client re-asserts its
locally-remembered status on connect. Under last-writer-wins, a desktop reconnecting with a
stale `online` in its `localStorage` **cleared** a `dnd` picked on the phone. Under priority,
the phone's live `dnd` holds.

### Intent is NOT persisted server-side

Deliberately. A durable per-user "dnd" key would recreate exactly the class of bug this ADR
removes: a TTL-less value outliving the device that set it, and worse than the original —
`dnd` suppresses notification sounds, toasts and the incoming-call overlay, so a stuck one is
a user who stops receiving calls and cannot see why.

Intent therefore lives as long as a device declares it, and each client re-asserts on connect
(`574537c`). The cost is bounded and visible: close every device that declared `dnd` and the
account releases to derived availability.

### Broadcast triggers

Connect and disconnect must now re-derive and compare. Pre-ADR they only re-broadcast on
`cameOnline` / `wentOffline` or a dominant-platform flip, which was complete then — a
disconnect could not change a per-user status. It can now, and this was a real bug caught by
the integration test, not a theoretical one:

- an **idle** desktop closing while an active phone remains → `idle → online`
- an **active** phone closing while an idle desktop remains → `online → idle`
- a phone connecting to an all-idle account → `idle → online`

None of these change online-ness or the dominant platform, so without the added status
comparison every peer keeps a stale dot until some unrelated presence event fires.

## Compatibility

**Wire contract: unchanged.** `PresencePayload` keeps its shape. An old client sends the same
`presence.update` frame and it is simply read as that connection's declaration. No client
change is required for this ADR to be correct.

**Live Redis keys.** Real users are connected across this deploy, and their `presence:status:*`
STRINGs are in Redis right now. The new key is deliberately named `:connstatus:` rather than
reusing `:status:` — a HASH read against a leftover STRING would fail with `WRONGTYPE`, so a
different name makes old and new data structurally incapable of colliding even if an old and a
new process briefly overlap. The new code neither reads nor writes the legacy key; the
existing startup `resetAll()` (`presence:*` scan, already run on every gateway boot precisely
because these keys have no TTL) deletes them the moment this version starts. Both properties
are pinned by tests — a legacy STRING is seeded and the store is exercised through every read
path, then wiped.

## Consequences

- Presence is correct for multi-device users, which is the normal case (desktop + phone).
- Every per-user fact in the presence store is now per-connection; there is no remaining
  server state that can outlive its socket. `close()` also stopped wiping the shared status
  key — it now `hdel`s only its own field, fixing a latent bug where one gateway instance
  shutting down cleared the status of connections it did not own.
- The reader in `packages/db` derives with the same shared function, so the invite card's
  online count and the presence dot cannot disagree.
- Multi-replica safe: state stays in Redis, derivation is a pure reduction over it.

### Known gap — client-side, tracked separately

The status picker reads per-device `localStorage`, not the account's derived status. So a user
who picks `dnd` on their phone still sees "Çevrimiçi" in the desktop picker while peers
correctly see the red dot. The server is right; the client's self-view is stale. Closing it
means the client learning its own authoritative status from the gateway — which needs the
handshake snapshot to carry the user's own **unmasked** status (it currently excludes self,
and masking would turn `invisible` into `offline`). That is a protocol shape change and a
two-platform client change: out of scope here, and it does not block this ADR — no peer-facing
status is wrong without it.

**Correction + partial closure (M16, 2026-10-20).** The sentence above was wrong about the
code: the snapshot did NOT exclude self. `groups.listCoMemberUserIds` includes the user, and
the gateway used it as the audience, so the user received their own PEER-masked presence — live
and in the snapshot — and an invisible user's own dot read `offline` on both clients. The fix
needed no shape change: the gateway removes self from `presenceAudience`, and sends the user's
OWN sockets a second copy of each `presence.updated` with the REAL derived status (the socket
whose handshake triggered the broadcast excluded; never `offline`). The snapshot is peers only;
the client seeds itself and gets the real status from the echo of its connect-time re-assert.
So the DOT now follows the account across devices. The PICKER still shows this device's own
choice — that half of the gap remains a UI decision. Contract text: `PresencePayload` in
`packages/protocol/src/events.ts`.

## Alternatives considered

- **Keep one per-user key, add a TTL.** Rejected: a TTL picks an arbitrary expiry for a fact
  that has an exact answer (the socket is open or it is not), and it would still let a
  departed device's `idle` rule until the timer elapsed.
- **Per-user durable intent + per-connection availability.** Rejected: reintroduces
  server-side state that outlives its device, for the highest-consequence status
  (see "Intent is NOT persisted").
- **Make `dnd`/`invisible` per-device with no priority.** Rejected: `invisible` would unmask
  as soon as a second device connected — a privacy failure — and `dnd` on the phone would not
  silence the desktop, which is the entire point of the setting.
- **Add a discriminator to `presence.update`** (e.g. "fresh pick" vs "re-assert") so the
  server could tell a deliberate change from a reconnect echo. Rejected for now: a protocol
  shape change needing product-architect sign-off and coordinated client releases, and the
  priority rule already solves the stomping case it was meant to address.
