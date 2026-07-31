# ADR 0008 — Media Attachments (M10): Storage, Access & Upload

**Status:** accepted — shipped; attachments are live on desktop, web and mobile
**Date:** 2026-07-08

## Context

Founder asks for M10: send photos, videos, audio clips and GIFs in text
channels. The main scenario is a two-person private group — partner chat plus
film-night — on desktop (Electron) and mobile (Expo RN). Today `messages` carry
text only; `attachments` is on the "later" list (CLAUDE.md §25) and no binary
storage exists anywhere in the stack.

Fixed constraints going in:

- **Infra is the ADR 0003 hybrid:** managed Supabase Postgres + a single
  self-hosted VPS running Caddy, API, realtime, LiveKit, coturn, Redis. The
  founder already holds a **paid Supabase membership**; ADR 0003 explicitly left
  Supabase Storage as a "adopt later, incrementally" option.
- **The VPS disk is nearly full: 96 GB total, 62 GB used → ~34 GB free.** That
  box is also the media hot path (LiveKit/TURN); it cannot absorb user uploads,
  and a single 100 MB film clip per message adds up fast.
- **Authorization already exists at the channel boundary.** Message reads/writes
  go through `channels.findWithMembership` (membership + role) and, once M9
  lands, the ADR 0007 channel-visibility filter (`requireChannelVisible`).
  Attachments must inherit that exact authority, not invent a second one.
- Security rules §28 are non-negotiable: type whitelist, size limits, content
  escaping, no stored-XSS, no location/EXIF leaks (this matters for a couple
  sharing home photos).
- Migration 0005 (roles) is in flight on a parallel branch; this work starts at
  **migration 0006**.

## Decision

### 1. Storage → Supabase Storage (private bucket)

Store attachment bytes in **Supabase Storage**, one private bucket `attachments`.

Why:

- The paid membership is already in use for Postgres (ADR 0003); Storage is the
  same project, same billing, zero new vendor.
- S3-compatible with a built-in **CDN**, **signed upload URLs**
  (`createSignedUploadUrl`) and **signed read URLs** (`createSignedUrl`) —
  exactly the primitives this design needs, managed and backed up.
- Keeps binaries **off the VPS disk** (34 GB free) and off the media hot path;
  storage scales without us buying bigger disks.

Rejected alternatives:

- **VPS local disk** — only ~34 GB free, no CDN, backups and I/O contention
  become our problem on the same box that must keep screen-share audio stable.
  A film-night group would fill it. Rejected.
- **Self-hosted MinIO on the VPS** — adds a stateful service, its own backups
  and the same disk pressure, on the one box we most need to stay lean. No
  benefit over a managed, already-paid Storage. Reconsider only if Supabase
  storage/egress cost ever becomes material.
- **Proxying uploads through the API** (client → API → storage) — doubles
  bandwidth, pins Node memory/backpressure on 100 MB video bodies, and buys
  nothing. Rejected in favour of **direct client → Supabase** via signed URLs;
  the API only signs and records.

### 2. Access model → private bucket + short-lived signed read URLs, authorized by our API

The bucket is **private**: no anonymous or public reads. Supabase RLS on the
bucket is effectively deny-all for anon/authenticated roles — **Supabase does
not know our channel/role membership, so it must not be the gatekeeper.** All
authorization lives in our API, which already knows it.

Flow: the API mints a **short-lived signed read URL** (TTL ~1 h) for an
attachment **only after** the same channel check that guards message reads
(`findWithMembership` + ADR 0007 `requireChannelVisible`). Attachments therefore
inherit the message's channel ACL with no separate attachment ACL. A leaked URL
expires quickly; the client refreshes expired URLs by re-requesting (batch
re-sign endpoint, see plan).

A **public bucket is rejected**: a shareable, effectively permanent URL would
bypass channel membership and role visibility entirely — a private film clip
between two people must never be world-readable.

### 3. Upload flow → signed direct upload, link at message create

```
1. Client picks/pastes/drops a file → validates type+size locally (fast reject),
   strips EXIF + downscales oversized images, reads width/height/duration.
2. Client → POST /channels/:id/attachments/upload-url { filename, mime, size, kind }.
   API authorizes (visible + text channel + not guest), re-validates mime against
   the whitelist and size against the per-kind cap (SERVER is authoritative),
   creates a `pending` attachments row, returns { attachmentId, uploadUrl, expiresAt }.
3. Client PUTs the bytes DIRECTLY to Supabase using the signed upload URL.
4. Client → POST /channels/:id/attachments/:attachmentId/complete.
   API verifies the object exists, magic-byte-sniffs it against the declared kind,
   flips the row pending → ready.
5. Client sends the message with `attachmentIds: [...]`. On message create the
   API/gateway links each ready attachment (uploader-owned, unlinked) to the new
   message id (ready → linked) inside the same operation.
```

Proxying the bytes through the API (step 3) is **rejected** for the reasons in
§1. Orphans (uploaded, never sent) are handled by a sweep job that deletes
`pending`/`ready` rows with `message_id IS NULL` older than 24 h and their
storage objects.

### 4. Limits (server-enforced, named constants in `@demli/config`)

| Kind    | Whitelisted MIME / ext                    | Max size |
|---------|-------------------------------------------|----------|
| `image` | png, jpg/jpeg, webp, **gif**              | 10 MB    |
| `audio` | mp3, ogg, wav                             | 20 MB    |
| `video` | mp4, webm                                 | 100 MB   |

- **Max 10 attachments per message.**
- **SVG is deliberately excluded** (stored-XSS vector).
- Per-user rate limit on the upload-url endpoint (~30/min, session-keyed like
  messages). Per-group storage **quota is deferred** (2-person groups are
  low-risk); we monitor Supabase usage and add a quota later.

### 5. Security (§28)

- **Whitelist by extension AND magic bytes.** Because the client controls the
  bytes on a direct upload, extension/declared-mime alone is untrustworthy. The
  `complete` step does a cheap **Range read of the object's first bytes** and
  rejects a magic-byte/kind mismatch (e.g. an `.exe` renamed `.png`). Owned by
  the security review.
- **Content-Disposition + safe Content-Type.** Objects are stored and served
  with a server-chosen `Content-Type` from the whitelist; non-renderable types
  get `Content-Disposition: attachment`. Uploads live on the Supabase storage
  origin (isolated from the app origin), so even a malicious file cannot script
  our renderer.
- **EXIF stripped client-side by default** for images (canvas re-encode, which
  also downscales huge phone photos). This is a **privacy requirement**, not a
  nice-to-have: a couple sharing home photos must not leak GPS coordinates. Not
  optional.
- **Storage paths are random UUIDs** in a private bucket; signed URLs are
  short-lived. No AV scanning in MVP (nothing is executed; downloads are
  user-initiated) — note as a future Supabase Edge Function hook.

### 6. GIF approach

Two separate things, deliberately unbundled:

- **File-as-GIF — ships in M10.** `.gif` is in the image whitelist; drag/paste a
  gif → uploads → renders as a looping, autoplay-muted, pause-offscreen tile.
  This literally satisfies "gif paylaşma" with zero external dependency.
- **Direct-media link preview — ships in M10 (lite).** Pasting a URL ending in a
  known media extension (`.gif/.png/.jpg/.mp4/...`) renders an inline media
  element client-side (no server fetch → no SSRF). Full OpenGraph unfurling
  (server fetches page metadata) is deferred — it adds an SSRF surface.
- **GIF search picker (Tenor/GIPHY) — deferred, founder-gated.** An in-app
  search picker needs a provider **API key**, which is a founder decision
  (provider + key creation, CLAUDE.md §33). When the key exists it is added as a
  thin feature: the client searches via **our API proxy** (keeps the key
  server-side, lets us cache + rate-limit). Not blocking M10 core.

## Consequences

- New `attachments` table (migration 0006), one domain type `Attachment` in
  `packages/types`, and `MessageDTO.attachments` + `SendMessagePayload.attachmentIds`
  in `packages/protocol` (+ schemas/factories). `message.send`/`POST message`
  content becomes optional **iff** attachments are present.
- New API surface: `POST .../attachments/upload-url`, `.../complete`, a batch
  read-URL re-sign endpoint, and an unlinked-attachment cancel delete; message
  delete must also purge storage objects. A new `apps/api/src/lib/storage.ts`
  wraps the Supabase Storage client (the only place the service-role key is used).
- Attachment read authorization **reuses** ADR 0007 channel visibility — no new
  ACL. One new orphan-sweep job.
- Client gains composer attach/paste/drag + EXIF strip + progress (desktop),
  picker upload (mobile), and lazy, aspect-ratio-reserved render components that
  keep the virtualized message list jank-free (§27).
- New external dependency footprint: Supabase Storage bucket + service-role key
  in `.env.prod` (founder approval, §33). GIF picker adds a second, optional
  provider key later.

## Alternatives considered

1. **VPS disk / self-hosted MinIO** — rejected in §1 (disk pressure, ops burden,
   competes with the media hot path, no CDN).
2. **Proxy uploads/downloads through the API** — rejected in §1/§3 (bandwidth
   doubling, memory/backpressure on large video, no benefit).
3. **Public bucket with unguessable URLs** — rejected in §2 (permanent shareable
   URLs bypass channel/role authorization).
4. **Supabase RLS as the authorization boundary** — rejected: Supabase has no
   knowledge of our friend-group/channel/role model; authorization must stay in
   the API that owns it. RLS is deny-all; the API is the sole minting authority.
5. **Attachments as first-class messages (one row per file, no text)** — rejected:
   duplicates the message pipeline and breaks "a gif with a caption". Attachments
   hang off a message (0..N) instead.
6. **Bundling a Tenor/GIPHY picker into M10** — rejected: needs a founder key
   decision and would block the core upload feature on an external dependency.
   File-as-GIF covers the literal ask now; the picker is a thin follow-up.
