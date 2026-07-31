# M10 Media Attachments — Implementation Plan

> **Shipped — this is the plan as written, kept as a record.** Media attachments (ADR 0008) are live in production on all three clients. It reads as
> forward-looking work orders because that is what it was; it is not a list of pending
> work. Current per-platform status lives in `docs/product/feature-parity.md`.

Design: ADR 0008. Order is strict: infra → DB → types/protocol → API → gateway →
UI → QA. Assumes migration 0005 (roles) has landed first; attachment read
authorization **reuses** the ADR 0007 channel-visibility check, not a new ACL.

## 0. Infra (devops-release, founder-gated)

Provision **before** any code merges:

- Supabase project → private bucket `attachments` (public = off).
- Bucket file-size limit + allowed-MIME set to the §4 whitelist (defence in
  depth behind the API's own checks).
- Enable image transformations (for thumbnail render params) if the plan tier
  allows; otherwise the client sends width/height and we skip server thumbnails.
- Service-role (or scoped) key into un-committed `.env.prod` +
  `apps/api/.env.example` as `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` /
  `SUPABASE_STORAGE_BUCKET`. This is the **only** place the service key is used.

## 1. Migration 0006 (`packages/db`)

```sql
CREATE TYPE attachment_kind AS ENUM ('image', 'video', 'audio');

CREATE TABLE attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   uuid REFERENCES messages(id)  ON DELETE CASCADE, -- NULL until linked
  channel_id   uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE, -- authz+cleanup pre-link
  uploader_id  uuid NOT NULL REFERENCES users(id),
  kind         attachment_kind NOT NULL,
  mime         text    NOT NULL,               -- exact whitelisted mime
  size_bytes   integer NOT NULL,               -- validated <= per-kind cap
  width        integer,                        -- image/video px; null for audio
  height       integer,                        -- image/video px; null for audio
  duration_ms  integer,                        -- audio/video; null for image
  storage_path text    NOT NULL,               -- bucket-relative object key
  status       text    NOT NULL DEFAULT 'pending', -- 'pending' | 'ready' | 'linked'
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_message_id_idx ON attachments(message_id);
CREATE INDEX attachments_sweep_idx      ON attachments(status, created_at); -- orphan sweep
CREATE UNIQUE INDEX attachments_storage_path_unique ON attachments(storage_path);
```

Notes:

- `message_id` nullable + `channel_id` denormalized so the row exists and can be
  authorized/cleaned during the upload window before it is linked to a message.
- Path convention: `attachments/{channelId}/{attachmentId}.{ext}` — private
  bucket + random UUID means the path is not sensitive and per-channel cleanup is
  trivial.
- Message **soft-delete** does not cascade; the delete path must also purge
  storage objects (see §3). Hard message delete cascades the rows (not the bytes).

Repo `attachmentsRepo`: `createPending`, `markReady`, `linkToMessage(ids, messageId, uploaderId)`
(guards uploader-owned + status='ready' + unlinked), `listForMessageIds(ids)`,
`findUnlinkedById`, `sweepOrphans(olderThan)`. Seed: one image attachment on a
seed message so UI/tests have a fixture.

## 2. Types & protocol (`packages/types`, `packages/protocol`)

`packages/config` — add named limits (no magic numbers):

```ts
export const ATTACHMENT_MAX_PER_MESSAGE = 10;
export const ATTACHMENT_LIMITS = {
  image: { maxBytes: 10 * 1024 * 1024, mimes: ["image/png","image/jpeg","image/webp","image/gif"] },
  audio: { maxBytes: 20 * 1024 * 1024, mimes: ["audio/mpeg","audio/ogg","audio/wav"] },
  video: { maxBytes: 100 * 1024 * 1024, mimes: ["video/mp4","video/webm"] },
} as const;
```

`packages/types`:

```ts
type AttachmentId = string;
type AttachmentKind = "image" | "video" | "audio";
interface Attachment {
  id: AttachmentId;
  messageId: MessageId | null;
  channelId: ChannelId;
  uploaderId: UserId;
  kind: AttachmentKind;
  mime: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  createdAt: string;
  // storagePath is server-internal and NEVER leaves the API.
}
```

`packages/protocol` (**shipped in M10-2 — this is the final contract**):

```ts
// Metadata only — NO signed URL, NO storagePath. Structurally identical to the
// domain Attachment; a distinct name keeps a wire extension point.
type AttachmentDTO = Attachment;

// Signed read URLs are the ONLY thing NOT in the message. They are short-lived
// (~1 h) and channel-authorized per request, so they ride a separate shape
// returned by the batch attachments-URL endpoint — never baked into a cacheable
// message payload.
interface AttachmentUrl { attachmentId; url; urlExpiresAt; thumbnailUrl?; }

// MessageDTO gains attachments (optional so text-only messages/fixtures are unchanged)
type MessageDTO = Message & { nonce?: string }; // attachments? inherited from Message

// Message (domain) gains attachments; SendMessagePayload gains attachmentIds
interface Message { /* … */ attachments?: Attachment[]; }
interface SendMessagePayload { channelId; content; nonce; attachmentIds?: AttachmentId[]; }
```

> **Contract decision (M10-2), supersedes the earlier "DTO carries url" sketch:**
> the message DTO carries attachment **metadata only**. Signed read URLs are
> delivered *exclusively* by `POST /channels/:channelId/attachments/urls` as
> `AttachmentUrl[]`. Rationale: a message payload is durable/cacheable and
> broadcast to many recipients, but a signed URL is ephemeral and per-viewer —
> embedding it would bake a 1 h TTL into cached messages and mint URLs for
> recipients who never render the tile. The client already needs the batch
> endpoint for expiry refresh + virtualization scroll-back, so metadata-only
> DTOs give it **one** URL code path (lazy fetch when a tile nears the viewport,
> §5) instead of two. `AttachmentDTO`/`Attachment` never carry `storagePath`.

zod (`schemas.ts`) — the one behavioural change: **content OR attachments**.

```ts
sendMessagePayloadSchema: content becomes .max(...) (min 0), plus
  .refine(p => p.content.trim().length > 0 || (p.attachmentIds?.length ?? 0) > 0,
          "Message must have text or at least one attachment")
  and attachmentIds: z.array(id).max(ATTACHMENT_MAX_PER_MESSAGE).optional();
messageDTOSchema: attachments: z.array(attachmentDTOSchema).optional();
attachmentDTOSchema: mirrors Attachment exactly (asserted _assertAttachmentDTO);
attachmentUrlSchema: the signed-URL response element.
```

Pre-M10 text clients are unaffected: a text send still passes the refine; the
old `content.min(1)` rejection is preserved for the text-only case. Compile-time
`_assert*` checks additionally pin `attachmentDTOSchema ⇄ Attachment` and the
config whitelist ⇄ `attachment_kind` union. **No new realtime events** —
attachments ride inside the existing `message.created` / `message.updated`;
uploads and URL fetches are HTTP.

## 3. API (`apps/api`)

`apps/api/src/lib/storage.ts` — thin Supabase Storage wrapper, sole holder of the
service key: `signUpload(path)`, `signRead(path, ttl)`, `headObject(path)`,
`rangeReadHead(path, bytes)` (magic-byte sniff), `deleteObjects(paths)`.

`apps/api/src/lib/attachments.ts` — shared logic: mime/size/kind validation,
magic-byte sniff, DTO enrichment (`attachment + signRead → AttachmentDTO`).

| Method | Path | Guard / behaviour |
|---|---|---|
| POST | `/channels/:channelId/attachments/upload-url` | member, not guest, channel visible, **text** channel; validate kind+mime+size; create `pending` row; return `{ attachmentId, uploadUrl, expiresAt }` |
| POST | `/channels/:channelId/attachments/:id/complete` | uploader; `headObject` exists + `rangeReadHead` magic-byte matches `kind`; sanity-clamp client width/height/duration; `pending → ready`; return `AttachmentDTO` (metadata) |
| POST | `/channels/:channelId/attachments/urls` | channel visible; body `{ attachmentIds }`; return `AttachmentUrl[]` — the **sole** source of signed read URLs (initial render, expiry refresh, virtualization scroll-back) |
| DELETE | `/channels/:channelId/attachments/:id` | uploader, only while unlinked; delete storage object + row (cancel an upload) |

Retrofits (same wave):

- `POST /channels/:channelId/messages` — accept `attachmentIds`; content optional
  when attachments present; **link** ready+unlinked+uploader-owned rows to the new
  message id (`ready → linked`) in one step; reject stale/foreign/pending ids.
- `GET /channels/:channelId/messages` — join attachments per message and emit
  `AttachmentDTO` **metadata** (bounded: one page). No signed URLs here; the
  client fetches them lazily from the batch URL endpoint (see contract note).
- `DELETE /messages/:id` (+ soft delete) — also purge the message's attachment
  storage objects (best-effort; row cascades on hard delete, sweep is the backstop).
- New cron/interval: `attachmentsRepo.sweepOrphans(24h)` → `deleteObjects`.

Rate limit: upload-url endpoint session-keyed (~30/min).

## 4. Gateway (`apps/realtime`)

- `message.send` handler: accept `attachmentIds`; on the existing nonce upsert,
  link the ready attachments to the resolved message id (idempotent — a retried
  send re-links to the same row set), then enrich the broadcast `message.created`
  payload with `AttachmentDTO[]` **metadata** (no signed URLs in the broadcast).
- Content-empty-with-attachments is valid; content-empty-without-attachments still
  answers `INVALID_PAYLOAD` (enforced by the shared schema).
- No new event types, no new error codes; invisible/forbidden channels keep
  answering `CHANNEL_NOT_FOUND` (ADR 0007). Recipients render from metadata and
  fetch signed URLs from the batch endpoint when a tile nears the viewport.

## 5. Client (`apps/desktop` renderer + mobile + `packages/ui`)

Desktop composer (`MessageComposer`):

- Attach button (paperclip) + hidden file input, **drag-drop** onto chat,
  **clipboard paste** (image paste → upload).
- Client-side per file: validate type/size, **strip EXIF + downscale** oversized
  images via canvas, read `width/height` (Image) and `durationMs`
  (`loadedmetadata`), show upload progress, allow remove before send.
- Pending-attachment tray above the composer; send is enabled with text **or**
  ≥1 ready attachment.

Mobile (Expo RN): `expo-image-picker` (photo/video) + `expo-document-picker`
(audio); same upload-url → PUT (signed URL) → complete → send flow with progress.

Render components (`packages/ui` + renderer), used by `MessageRow`:

- `MessageAttachments` (grid/stack), `ImageAttachment` (click → lightbox),
  `VideoAttachment` (inline `<video controls preload=metadata>`, lazy),
  `AudioAttachment` (native `<audio>` / light waveform), `GifAttachment`
  (loop, autoplay-muted, pause when offscreen).
- **Lazy + no-jank:** reserve the tile's box from stored `width/height`
  (aspect-ratio) so the virtualized `MessageList` (`@tanstack/react-virtual`)
  does not shift on load (§27); fetch the actual bytes only when near the
  viewport (IntersectionObserver); re-sign expired URLs via the batch endpoint.
- Expired/broken URL → retry affordance, never a raw error.

## 6. Test plan

- **db:** attachment insert; `storage_path` unique; hard-delete cascade from
  messages; `linkToMessage` guards (foreign uploader / not-ready / already-linked
  rejected); `sweepOrphans` selects only stale unlinked rows.
- **api (integration):** upload-url authz (guest rejected, non-member 404,
  non-text channel rejected, over-cap size rejected, non-whitelist mime rejected,
  invisible channel 404 per ADR 0007); `complete` magic-byte mismatch rejected;
  message create with `attachmentIds` links rows and returns DTOs with URLs;
  content-empty-with-attachment allowed, content-empty-alone rejected;
  re-sign endpoint authz; cancel-delete only-while-unlinked.
- **gateway:** `message.send` with attachments broadcasts `message.created`
  carrying `attachments[]`; retried send (same nonce) does not duplicate links.
- **security review (§28):** magic-byte sniff, `Content-Disposition`, SVG
  excluded, EXIF strip verified on a real geotagged JPEG, signed-URL TTL, private
  bucket / RLS deny-all, SSRF-safe link preview (client-only).
- **client:** upload progress + cancel; EXIF strip; lazy load; expired-URL
  refresh; virtualization no layout shift on image load.
- **manual QA (two clients, film-night):** B uploads a 100 MB mp4, A sees it;
  paste a gif; upload a voice clip; upload a geotagged phone photo and confirm no
  location leak; scroll far back and confirm old attachment URLs re-sign.

## 7. Task split & order

| # | Task | Agent | Branch | Depends on | Est |
|---|---|---|---|---|---|
| 0 | Supabase bucket + keys + `.env.example` | devops-release | `feat/media-infra` | **founder storage approval** | 0.5d |
| 1 | Migration 0006, schema.ts, `attachmentsRepo`, seed, db tests | database | `feat/media-db` | 0005 merged, 0 | 1d |
| 2 | config limits + types `Attachment` + protocol DTO/payload/schemas/factories | product-architect | `feat/media-contract` | — (parallel w/ 1) | 0.5d |
| 3 | `storage.ts` + `attachments.ts` + upload-url/complete/urls/cancel + message link + DTO enrich + delete purge + sweep | realtime-backend | `feat/media-api` | 0,1,2 | 2d |
| 4 | Gateway `message.send` attachment link + broadcast enrich | realtime-backend | `feat/media-gateway` | 3 | 0.5d |
| 5 | Desktop composer (attach/paste/drag, EXIF strip, progress, tray) + render components + lazy/virtualization | frontend-ui | `feat/media-ui-desktop` | 3 (API stable) | 2.5d |
| 6 | Mobile picker + upload + render components | frontend-ui (mobile) | `feat/media-ui-mobile` | 3 | 1.5d |
| 7 | db/api/gateway/client suites + manual checklist | qa-test | `feat/media-qa` | 4,5 | 1d |
| 8 | Security review: magic-byte, disposition, EXIF, signed-URL TTL, bucket RLS, SSRF | security | review only | 3,4 | 0.5d |
| 9 | Update `docs/architecture/overview.md` + README setup after merge | docs | `docs/media` | 7 | 0.5d |
| 10 | *(follow-up, founder-gated)* GIF search picker via API proxy (Tenor/GIPHY) | realtime-backend + frontend-ui | `feat/gif-picker` | **founder key** | 1.5d |

Gates: `pnpm typecheck && pnpm lint && pnpm test` green at every merge; contract
task (#2) must keep the `packages/protocol` `_assert*` sync checks green; the API
+ gateway (#3/#4) additionally need the two-client upload smoke before merge.

## 8. Founder decisions required (§33)

1. **Supabase Storage approval** — use the paid Supabase project's Storage
   (private bucket + signed URLs) for attachments, and provide/confirm the
   service key is available to the API. (Alternative = MinIO on the VPS, not
   recommended: ~34 GB free, competes with the media hot path.)
2. **GIF search picker** — do you want an in-app GIF search? If
   yes: **Tenor (Google) or GIPHY**, and can you create the API key? Without it,
   M10 still ships uploading `.gif` files + pasting gif links; the picker is a
   thin follow-up.
3. **Limits sanity check** — image 10 MB / audio 20 MB / video 100 MB, max 10
   files per message. (100 MB suits short clips; full movies go over screen
   share, not upload.) OK, or adjust?
