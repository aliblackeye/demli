# Demli — Product Vision

## What it is

Demli is a self-hosted communication app for **private friend groups**. Friends create a
private server, chat in text channels, join voice rooms, turn on cameras, share their screen,
and call each other directly — with stable, high-quality audio and video.

It runs on three surfaces, kept at feature parity: a **Windows Electron desktop app**, an
**Android app** (Expo / React Native), and a **browser client** that mounts the desktop
renderer unchanged. macOS is planned. The original scope was desktop-only; mobile and web
came later and are now first-class, not afterthoughts.

It is not trying to be anyone else's product. It started as a tool a small group
actually uses daily, and it still is — it just got good enough to show people.

## Who it's for

- Private friend groups (gaming, hobby, work-adjacent circles) of roughly 2–20 people.
- People who want a fast, calm, reliable place to talk — not a social platform.
- Invite-only. You join a group because a friend invited you, not because you discovered it.

## What "premium private communication tool" means

- **Voice first.** Voice must work, screen share must be stable, reconnect must recover cleanly.
  A beautiful UI with broken voice is a failure.
- **Premium feel.** Dark-first, clean contrast, compact but readable, smooth but not over-animated.
  Linear + Raycast influence. Not childish, not noisy, not a neon gamer toy.
- **Private by design.** Groups are closed spaces. No public rooms, no strangers.
- **Reliable.** Messages persist, reconnects recover, errors are user-friendly, never raw stack traces.

## Quality order

1. Voice works.
2. Screen sharing is stable.
3. Reconnect recovers cleanly.
4. Chat is reliable.
5. UI feels premium.
6. Extra features come last.

## What it is NOT

Still true, and still deliberate:

- No bot systems or integrations.
- No public discovery, server browsing, or community features.
- No Nitro-like premium tiers, boosts, or monetization mechanics.
- No sticker/GIF marketplace, forum channels, or stage channels.

These are scope cuts, not gaps.

**Changed since the MVP:** roles started as a flat Owner / Member / Guest split. Custom roles
with a permission set shipped later (ADR 0007) — still deliberately far from a full
permission hierarchy, but no longer three fixed names.

Current, honest per-platform status lives in
[feature-parity.md](./feature-parity.md); the frozen original milestone plan is in
[mvp-scope.md](./mvp-scope.md).
