# ADR 0016 — Watch Party: WS-Synced Embedded YouTube Player (Free Path)

**Status:** accepted — sync contract + gateway + desktop/web player shipped 2026-07-28.
**Amended 2026-07-28 (wave 2):** the MVP's two deferred items are now IN — a per-session **queue**
and **in-app YouTube search** — and the founder's "put a browser inside it" request is explicitly
REJECTED with reasons (see §Wave 2). Mobile player remains the open surface.
**Date:** 2026-07-27 (accepted 2026-07-28; amended 2026-07-28)

## Context

M20 lists Watch Party **only if a free path exists** (founder rule: anything paid is asked
first). Screen share + system audio already works in production (desktop shares, desktop and
mobile watch), so "watching together" is possible today. The question is whether a dedicated
Watch Party feature adds enough over that, at zero licensing cost.

## Options

### (a) Status quo: existing screen share — 0 work

- **Pros:** live today on both platforms; carries ANY content the sharer can play (local
  files, any site); system audio included; zero new code.
- **Cons:** one upstream from the sharer's connection (bandwidth-bound, typically 2–8 Mbps
  up); re-encoded quality (bitrate presets, motion smear on film content); noticeable
  latency; **session dies when the sharer leaves or crashes**; sharer's machine must keep
  playing the content.
- **DRM reality:** Netflix / Disney+ / Prime use Widevine. With hardware-protected playback
  the captured region renders **black**; software-decode configs sometimes capture but are
  unreliable and circumvention-adjacent. **There is no legal/free way to sync or capture DRM
  services in ANY option.** Teleparty-style products are browser extensions running inside
  each member's own logged-in browser — outside our app. Founder expectation must be set:
  DRM "movie night" stays screen share, with the black-screen caveat.

### (b) WS-synced embedded YouTube player — RECOMMENDED

Everyone plays the video from YouTube themselves; our server only syncs
play/pause/seek/host state over the existing WS gateway.

- **Free and ToS-compatible:** the official iframe embed (`youtube-nocookie.com`) is free,
  needs no API key for playback, and is allowed as long as the player is unmodified (no ad
  stripping, no hiding). We paste a link; no YouTube Data API in MVP.
- **Quality independent of any member:** no upstream cost, full source quality, session
  survives the starter leaving (host handoff).
- **Control without external scripts:** build the iframe with `enablejsapi=1` and drive it
  via `postMessage` — no `iframe_api` script load, so `script-src 'self'` is untouched.
- **Risks / mitigations:**
  - *Electron CSP:* there is no `frame-src` today, so `default-src 'self'` blocks all
    iframes. One directive is added (see Security impact).
  - *Embed-disabled videos:* some videos refuse embedding → per-user player error; host
    picks another link. Accepted.
  - *Ads:* play per-viewer at different moments — a drift source we cannot remove for free.
    Accepted; drift correction re-converges after the ad.
  - *Sync drift:* server state is authoritative; clients seek when drifted > ~2 s.
  - *Mobile autoplay:* WebView needs a user gesture — "tap to join playback" on entry.
  - *Who controls:* host = starter; explicit transfer; auto-handoff when host leaves voice;
    group owner can always take over or stop.

### (c) Local file sync — rejected for MVP

Same sync protocol, playback via native `<video>`. Fails on distribution: everyone must
already have the identical multi-GB file (attachments are capped; VPS bandwidth/storage is
not for movie files), codec/container variance across platforms, and piracy adjacency. The
event contract below is source-agnostic, so this can return later without protocol changes.

## Decision

Build Watch Party as **(b)**: a YouTube-synced session bound to a voice channel, on both
platforms. **(a) remains the documented answer for everything not on YouTube** — including
DRM services, where no free/legal sync path exists, full stop. (c) is deferred.

**MVP in:** YouTube links only; one session per voice channel; host controls
(play/pause/seek/change video), transfer + auto-handoff; drift correction; desktop + mobile
playback (mobile via WebView embed, e.g. `react-native-youtube-iframe`).
**MVP out:** queues/playlists, other providers, in-app YouTube search, DRM services,
reactions overlay, subtitle sync, watch history, persistence across restarts.
**(Wave 2 moved queues and in-app search from "out" to "in" — see below. The rest stand.)**

## Protocol events (AS BUILT — `packages/protocol`)

Keyed by `channelId` (one session per voice channel, mirroring voice occupancy — no
separate sessionId). State is ephemeral in Redis (TTL), no DB table in MVP. Sender must be
an occupant of the voice channel; control requires host (or group owner).

```ts
// ClientToServerEvent additions
| { type: "watch.start";         payload: { channelId; source: "youtube"; videoRef } }
| { type: "watch.control";       payload: { channelId; action: "play" | "pause" | "seek"; positionSec } }
| { type: "watch.set_video";     payload: { channelId; videoRef } }
| { type: "watch.transfer_host"; payload: { channelId; toUserId } }
| { type: "watch.stop";          payload: { channelId } }

// ServerToClientEvent additions — `started` and `state` share ONE payload
type WatchSessionState = { channelId; hostId; source; videoId; positionSec; playing; serverTime };
| { type: "watch.started";      payload: WatchSessionState }
| { type: "watch.state";        payload: WatchSessionState } // control + ~5 s heartbeat + join/resync
| { type: "watch.host_changed"; payload: { channelId; hostId } }
| { type: "watch.stopped";      payload: { channelId; reason: "host_stopped" | "channel_empty" } }
```

Session ends when the voice channel empties or the host stops it. `watch.state` piggybacks
on the reconnect resync path the same way `voice.resync` does.

### Deviations from the sketch, and why

1. **`videoId` → `videoRef` on the CLIENT→server events.** The MVP interaction is "paste a
   link", so the field carries a bare id *or* an ordinary YouTube URL and the SERVER
   normalizes it (`parseYouTubeVideoId`, `packages/config`). Server→client keeps `videoId`
   and it is ALWAYS the normalized 11-character id. Two names because they are two
   different things: one is untrusted input, the other is the only shape allowed near an
   iframe URL. Rejected at the protocol boundary AND re-parsed in the handler; unknown
   hosts, lookalike domains (`youtube.com.evil.test`), `javascript:` schemes and wrong-length
   ids all fail. Tested in `packages/protocol/src/__tests__/watch-party.test.ts`.
2. **`watch.state` gained `hostId` and `source`** (making it identical to `watch.started`).
   The sketch's `watch.state` was also the join/resync frame, but a client that joins
   mid-session and receives only `{videoId, positionSec, playing}` cannot know who controls
   playback — it would have to guess whether to render its own controls. One payload, one
   upsert path on the client, no "first frame" special case.
3. **`watch.started` doubles as the (re)connect snapshot** (upsert-by-channelId, not "just
   began"), exactly like the `auth.succeeded` voice-occupancy snapshot. No third event.
4. **Audience is split** (§27): lifecycle (`started`/`host_changed`/`stopped`) goes to every
   visibility-filtered subscriber of the channel so a member can see "a party is running";
   the 5 s drift `watch.state` goes only to sockets actually IN the voice room. The sketch
   implied one audience for everything, which would have fanned a 5 s heartbeat at people
   who are not watching.
5. **Three new `RealtimeErrorCode`s** — `NOT_IN_VOICE`, `NOT_HOST`, `WATCH_NOT_ACTIVE`. They
   need different UI ("join the room", "ask the host", "nothing is running"); one shared code
   would leave the client guessing.
6. **Timeout gate added** (ADR 0019, not mentioned in the sketch): a timed-out member controls
   nothing, for the same reason they cannot send a message on either transport.
7. **Occupancy is required of the OWNER too.** The owner override applies to the host check
   only — a server owner who is not in the room cannot reach into it.

Blocking (ADR 0017) is deliberately NOT a gate: a block has never stopped two members sharing
a voice channel, `watch.*` carries no authored content of anyone, and filtering it per
recipient would desync the playback it describes — the same reasoning that leaves
`message.deleted` and reaction deltas unfiltered (ADR 0017 §3).

## Wave 2 (2026-07-28) — queue + in-app search

Founder request, verbatim: *"watch partye listeye video ekleyebilmek, link vermek değil de browser
yap içine, oradan seçsin. … watch party i açan kişi sıraya alsın sırayı değiştirsin ve videoyu
oynatsın."*

### Decision a — NO embedded browser. In-app search instead.

"Put a browser inside the panel" is rejected on two independent grounds, either of which is fatal:

1. **It cannot be built with an iframe.** `youtube.com` sends `X-Frame-Options: SAMEORIGIN` and
   refuses to render in our frame. Only `youtube-nocookie.com/embed/<id>` — a single video, not a
   browsable site — is frameable. There is no "browse YouTube in an iframe".
2. **The only thing that could work would demolish this feature's containment.** An Electron
   `<webview>` (or a `BrowserView`) renders arbitrary web pages inside the app. That is precisely
   what the security work for wave 1 was built to prevent: `frame-src` is pinned to exactly one
   host, `will-frame-navigate` locks the embed in place, and `setWindowOpenHandler` denies
   unconditionally. Opening a general browser would make all three decorative, on the surface where
   a stranger's link is most likely to be pasted.

So the browsing happens in **our** UI against **our** endpoint: `GET /watch/search` calls YouTube
Data API v3 `search.list` server-side and returns normalized results (videoId, title, channel,
duration, thumbnail) that render as an ordinary list. The user gets what they asked for — pick a
video without pasting a link — and the sandbox stays shut. This is the item the original ADR
deferred as "revisit post-MVP"; this is the revisit.

**The API key is a real constraint, and the design answers it rather than hiding it.** Google
grants 10,000 quota units/day per project; `search.list` costs 100 and the batched `videos.list`
for durations costs 1. That is ~99 searches **per day for the entire deployment** — a hard external
ceiling, not a rate limit. Layered accordingly:

- per-session HTTP rate limit (10 / 10 s) — protects our server from a request-per-keystroke client;
- per-user daily cap (25 searches) — one person cannot spend the friend group's day;
- deployment-wide daily budget (9,000 units, 10% under the real ceiling) in **Redis**, so it
  survives the deploys that would reset a process-local counter;
- 10-minute result cache — re-running a query while deciding is free and spends no units.

**Keyless is a first-class state, not a failure.** With no `YOUTUBE_API_KEY` the search route
answers 503 and — the part that matters — `GET /watch/capabilities` answers
`{ searchEnabled: false }`, so a client renders the paste-a-link path *instead of* a search box.
§35 forbids a control that looks pressable and does nothing, and "the user finds out by typing a
query and pressing enter" is exactly that control. Playback and the queue never needed a key.

### Decision b — the queue lives in the session, and names ITEMS, not positions

The queue is an ordered list inside the same TTL'd Redis session record as the playhead: same key,
same lifetime. A queue that outlived its party would be a list of videos belonging to nobody.

Every mutation names an `itemId` (a client-minted uuid), never an index. Two people control one
queue — the host and the server owner — and the auto-advance mutates it from the server's side the
moment a video ends, so an index the client computed a moment ago may already mean a different row.
`itemId` is a uuid rather than the loose ambient `id` for the same reason: a client numbering rows
"1", "2", "3" would collide with the other controller's rows, and because an add is idempotent on
`itemId`, a collision would not error — it would silently drop the second person's video.

**Reorder carries the desired FULL ORDER, not a move.** The server reconciles it against what it
actually holds: unknown ids are ignored, unmentioned items keep their relative order at the end, and
no id can appear twice. So two racing reorders always leave a valid permutation of the real queue —
the later one merely wins the arrangement. An index-based "move item 3 to position 1" under the
same race silently moves the wrong row.

**Authority is the existing gate, unchanged:** host ∨ server owner, through the same
occupancy → membership/kind → timeout → host/owner chain the playback controls use. The founder's
rule is "whoever opened the watch party queues, reorders and plays" — and the host *is* that person.
A jukebox where any occupant may enqueue is a different product decision; it would arrive as a
change to `mayControl` alone.

**Cap: 50 items**, refused with a distinct `WATCH_QUEUE_FULL` (the honest answer — "remove one" —
is actionable, and `INVALID_PAYLOAD` would have told the user their video was wrong when it was
fine).

**Audience: occupants only, on change only.** `watch.queue_updated` is its own event rather than a
field on `watch.state`, because `watch.state` is the 5 s drift heartbeat — the frame this feature
sends most often, existing to carry a number that changes every tick. The queue changes a handful
of times an evening. Folding it in would multiply the size of the hot frame by the length of a list
that is almost always identical to the one sent five seconds ago (§27). A socket receives the queue
when it joins the room and on every change after.

### Decision c — the host's client reports "ended", the server decides what is next

Forced by what each side knows. The gateway never calls YouTube for playback — that is the whole
reason this feature is free — so it never learns a video's **duration** and cannot time an ending.
The host's player knows the instant it happens, and the host's playhead is already authoritative for
every other control (`watch.control` carries the host's own `positionSec`). Keeping the
*consequence* on the server is what stops "what plays next" from being negotiated between clients:
one queue, one advance, one fan-out.

`watch.ended` carries the `videoId` that finished as an **idempotency guard**: a player can report
ENDED more than once, and a late report can arrive after the video was already changed by hand.
Any `watch.ended` naming a video that is not the current one is ignored, so a duplicate can never
eat an extra item off the queue.

**When the queue runs out the session STAYS**, paused at the end of the last video. Ending it would
tear the party down while the room is still sitting there deciding what to watch next — and
`watch.stopped` is the signal that clears the channel-wide "party running" badge, a badge that
should still be showing. The two honest ways a party ends are unchanged: the host stops it, or the
room empties.

### Wave 2 protocol additions

```ts
// ClientToServerEvent
| { type: "watch.queue_add";     payload: { channelId; itemId; videoRef; title?; durationSeconds? } }
| { type: "watch.queue_remove";  payload: { channelId; itemId } }
| { type: "watch.queue_reorder"; payload: { channelId; itemIds: string[] } }   // desired FULL order
| { type: "watch.queue_play";    payload: { channelId; itemId } }
| { type: "watch.ended";         payload: { channelId; videoId } }             // idempotency guard

// ServerToClientEvent
type WatchQueueItem = { itemId; videoId; addedBy; addedAt; title | null; durationSeconds | null };
| { type: "watch.queue_updated"; payload: { channelId; queue: WatchQueueItem[] } }  // occupants only
```

New `RealtimeErrorCode`: `WATCH_QUEUE_FULL`. New `ApiErrorCode`s: `WATCH_SEARCH_DISABLED`,
`WATCH_SEARCH_QUOTA`, `WATCH_SEARCH_UNAVAILABLE` — three, because they clear on completely different
timescales (never / at YouTube's midnight / possibly in a minute) and a client must be able to say
which happened.

`watch.queue_add` requires a LIVE session (`WATCH_NOT_ACTIVE` otherwise): `watch.start` stays the
one and only way a session comes into existence, so exactly one place decides who may open a party.

### Wave 2 trust boundaries

- `videoRef` on a queue add is re-normalized server-side exactly as `watch.start` is; only the
  11-character id is ever stored or broadcast.
- `title` / `durationSeconds` on a queue row are **display metadata the adding client supplies** —
  the gateway has no metadata source of its own, and a queue of 50 opaque ids is unusable. Bounded,
  and **sanitized** at the protocol boundary: control characters, zero-width characters and bidi
  overrides are collapsed, so one row cannot span several visual lines or render backwards on
  someone else's screen. `addedBy` is server truth and always attributes it.
- Search results are **not trusted**: every returned `videoId` re-passes `parseYouTubeVideoId` and a
  failure is DROPPED rather than repaired; `thumbnailUrl` is **built by us** from that validated id
  (`youtubeThumbnailUrl`) rather than taken from the response, because the response's URL would be
  an externally-controlled string rendered as an `<img src>` on every member's machine.
- The search key never reaches a client, and the default fetch refuses redirects — the request URL
  carries the key in its query string, and following a redirect would hand it to whatever host the
  redirect named.
- Search is authorized by session + channel visibility + "it is a voice channel", so an
  authenticated stranger cannot use our key as a free YouTube proxy.

### Wave 2 evidence

`apps/realtime/src/__tests__/gateway.watch-queue.int.test.ts` (13, real sockets) ·
`apps/realtime/src/__tests__/watch-queue-reorder.test.ts` (8) ·
`packages/protocol/src/__tests__/watch-queue.test.ts` (15) ·
`apps/api/src/__tests__/watch-search.int.test.ts` (11) ·
`apps/api/src/__tests__/watch-search.unit.test.ts` (15) ·
`apps/api/src/__tests__/watch-search-fetch.int.test.ts` (6 — the DEFAULT fetch seam over a real
local HTTP server, because a seam that is only ever mocked is a seam nobody has run) ·
`packages/db/src/__tests__/watch-party.test.ts` (+4, including a **pre-queue session record** read
as an empty queue — live production sessions have no `queue` field, and treating that as malformed
would have ended every watch party running at the moment this deploys).

### Wave 2 open surfaces

Desktop/web queue panel and search UI, and the mobile player (which still no-ops every `watch.*`
frame). Both clients acknowledge `watch.queue_updated` as an explicit no-op today.

## Security / CSP impact

- **Desktop CSP** (`demli-csp` plugin, `apps/desktop/electron.vite.config.ts`): add
  exactly one directive — `frame-src https://www.youtube-nocookie.com`. `script-src`,
  `connect-src` unchanged (postMessage control, no external script).
- **Electron main:** `will-navigate` / `setWindowOpenHandler` guards must still deny
  navigation out of the embed (player links → `shell.openExternal` or deny).
  `electron-security-review` is mandatory before merge.
- **Web app:** the Caddy-served CSP for `apps/web` needs the same `frame-src`.
- No new secrets, no paid keys, media SFU untouched — sync is data-plane only over the
  existing typed WS contract (§24/§35 respected).

## Consequences

- New typed `watch.*` events in `packages/protocol`; small gateway handler + Redis state;
  a player tile in the voice stage (desktop `EmbeddedCallStage`/`VideoStage` area, mobile
  `voice/[channelId]`); one CSP directive loosened, security-reviewed.
- **Server half is live in production**: `apps/realtime/src/watch-party.ts`
  holds every authority decision, `RedisWatchPartyStore` holds the TTL'd session, and
  `apps/realtime/src/__tests__/gateway.watch-party.int.test.ts` proves the refusals and the
  no-stuck-room rules over real sockets. Both clients acknowledge the four server events as
  explicit no-ops so their exhaustive event switches still compile — the player wave replaces
  those with real handling.
- Founder expectation is now written down: Netflix/Disney+ sync is impossible for free and
  legally — those nights stay on screen share.

## Alternatives considered

- **(a) screen share only** — kept as fallback, insufficient as the *only* path (sharer
  bandwidth, quality, sharer-dependent lifetime).
- **(c) local file sync** — rejected for MVP (distribution problem); protocol reserved.
- **Paid sync APIs / paid embed products** — not evaluated; founder rule excludes paid
  paths without prior approval.
- **YouTube Data API for in-app search** — free quota exists but adds a key + quota
  management; MVP is paste-a-link. Revisit post-MVP. **→ Revisited and ADOPTED in wave 2**
  (2026-07-28) with the quota design above; the paste-a-link path remains and is the automatic
  fallback whenever the key is absent or the budget is spent.
- **Embedded browser (`<webview>`) for picking videos** — rejected in wave 2. `youtube.com`
  refuses framing outright, and the only mechanism that could work would reopen every navigation
  hole the wave-1 CSP and `will-frame-navigate` lock were built to close.
- **Index-based queue reordering** — rejected: two controllers plus a server-side auto-advance
  make any index the client computed potentially stale, so a race silently reorders the wrong row.
  A full desired ordering reconciled against server truth cannot.
- **Server-side auto-advance on a timer** — impossible without paying for metadata: the gateway
  never learns a video's duration, because playback deliberately needs no API key.
