# ADR 0015 — NSFW: Channel Flag, Client Age Gate, Server Moderation Seam (Fail-Open)

**Status:** accepted (shipped 2026-07-26, migration 0018)
**Date:** 2026-07-26

## Context

M15 adds NSFW support: a per-channel `nsfw` flag, an 18+ entry
gate, and media screening. Constraints:

- An earlier attempt wired nsfwjs+tfjs into the renderer: ~40 MB of model shards and
  trivially bypassable (a crafted request skips the client entirely).
- The founder has not chosen a moderation provider (hosted API vs self-hosted model),
  and the current VPS is too weak to run a model. Decision: **nothing is wired now**;
  it turns on when the infrastructure moves to a stronger server.
- A moderation outage must never block profile edits or message sends in a private
  friends-group app.

## Decision

- **`channels.nsfw`** (migration 0018) marks a channel NSFW; toggle at create/settings,
  18+ marker in the channel list.
- **Age gate is client UX,** driven by the me-only derived `isAdult` (ADR 0014):
  under-18 / no-birthdate gets a hard block ("add your birthdate in settings"); adults
  confirm once per channel on first entry. The server does not gate channel *reads* —
  the enforcement surface is media upload.
- **Media screening is a server-side seam, not a bundled model.**
  `apps/api/src/lib/media-moderation.ts` defines one pluggable `MediaModerator` used by
  three subjects: `avatar` and `banner` (always screened) and `attachment` (screened
  only when its channel is NOT NSFW — NSFW media belongs in NSFW channels).
- **One env flag, fail-open default.** `MEDIA_MODERATION_MODE=off` (default) makes the
  seam a no-op (`skipped`) — no upload is ever rejected for NSFW. When set to on, the
  seam dynamically `import()`s `MEDIA_MODERATION_MODULE`
  (`moderateImage(input) → { nsfw, score? }`). A module that is missing or throws also
  yields `skipped` — only an explicit `{ nsfw: true }` from a live module rejects.

## Consequences

- Today, in production, nothing is rejected for NSFW content anywhere. That is a
  deliberate founder decision, not a gap.
- Enabling moderation later costs one env flip plus a module — no code change, no
  redeploy of a model inside the API image.
- The check sits on the upload/complete path, before bytes are linked to a message or
  profile — unbypassable once enabled.
- The 18+ gate is honest UX, not security: an API caller can read an NSFW channel.
  Acceptable for a private-friends product; revisit if the product goes public.

## Alternatives considered

- **Client-side model (nsfwjs in the renderer)** — 40 MB, bypassable. Rejected (tried).
- **Model bundled in the API image** — ops weight and premature provider lock-in while
  no provider is chosen. Rejected in favor of a runtime module specifier.
- **Fail-closed seam** — a moderation outage would block every avatar/banner/attachment
  upload. Rejected; only an explicit positive verdict may reject.
- **Screening attachments in NSFW channels too** — contradicts the model the founder
  asked for; NSFW channels are the sanctioned place for such media. Rejected.
