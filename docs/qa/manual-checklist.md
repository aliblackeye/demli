# Manual Smoke Checklist

Run the relevant section before merging a branch that touches that area (CLAUDE.md §22).
Check off items in the PR/handoff note. Items marked with a milestone apply once that
milestone's features exist.

## Milestone 0–1 baseline (run now)

- [ ] `pnpm install` succeeds from a clean checkout
- [ ] `pnpm typecheck` passes
- [ ] `pnpm dev:desktop` opens the dark shell window

## Electron (any desktop change)

- [ ] App opens
- [ ] No main-process or preload errors in the terminal
- [ ] No renderer console crash (DevTools console clean of uncaught errors)
- [ ] Basic navigation inside the app works
- [ ] External links open in the OS browser, not inside the app
- [ ] IPC calls are validated (spot-check new handlers)

## Chat (from Milestone 2)

- [ ] Can send a message
- [ ] Can receive a message from another client
- [ ] Reload the app — messages persisted
- [ ] Kill the network mid-send — optimistic failed message does not corrupt the UI
- [ ] Scroll back through history — pagination does not duplicate messages

## Media / voice (from Milestone 3)

- [ ] Can join a voice room
- [ ] Can mute/unmute
- [ ] Can leave the room cleanly
- [ ] Drop the network — reconnect recovers (or fails with a clear error, no zombie state)
- [ ] Permission denied (mic) shows a user-friendly error, app stays usable

## Screen share (from Milestone 4)

- [ ] Can start screen share via the source picker
- [ ] Sharing a video plays its **system/film audio** for the viewer (loopback captured)
- [ ] Can stop screen share
- [ ] Close the shared window/source externally — track-ended is handled, UI recovers
- [ ] Permission denied (screen) shows a user-friendly error

## Mobile app (from Phase E)

- [ ] Android dev-client/APK installs and launches (built via EAS — needs an Expo account)
- [ ] Server URL configurable in-app; points at the deployed domain (or LAN IP in dev)
- [ ] Sign in / register works against the real backend
- [ ] Chat: send/receive, presence, typing (no duplicate messages on scrollback)
- [ ] Join a voice channel; mic mute/unmute; speaking indicators
- [ ] **Watch** a desktop-shared screen: video renders and **film audio plays**
- [ ] Host stops sharing — mobile viewer returns cleanly to no-share

## Attachments (M10) — desktop + mobile

Needs a backend with `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`/`SUPABASE_STORAGE_BUCKET`
set, two signed-in clients in the same text channel, and `exiftool` on the desktop
machine. Items tagged **[BLOCKING]** gate the next desktop installer and Android APK
(the M10-6 native modules mean current phones get no OTA until the new APK ships —
these must pass on that APK build). Untagged items are pre-GA follow-ups: note
failures, they do not hold the build.

### Desktop upload (client A)

- [ ] **[BLOCKING]** Paperclip → pick an image → tray shows progress → ready → send;
      client B sees the tile without reloading
- [ ] **[BLOCKING]** Clipboard-paste a screenshot and drag-drop a file onto the chat —
      both land in the tray and send
- [ ] **[BLOCKING]** Caption-less send (attachment only, empty text) renders as a
      tile-only message on BOTH desktop and mobile receivers (no empty text row)
- [ ] **[BLOCKING]** One message with 2+ attachments: every tile resolves and renders
      on a second client (regression: idsKey NUL/space split, commit 917bd5d —
      single-attachment messages worked while multi-attachment batches were garbled)
- [ ] **[BLOCKING]** Video over the 100 MB cap is rejected upfront with a friendly
      error (no upload starts); an mp4 at/below the cap uploads and plays inline
- [ ] **[BLOCKING]** Geotagged JPEG (phone photo with GPS EXIF): send it, download the
      object from its signed URL, run `exiftool` — **no GPS/location tags** remain
- [ ] Slow network (DevTools throttling): progress bar advances; remove × mid-upload
      stops the progress and the draft disappears; nothing sends
- [ ] More than 10 files at once: the overflow drafts surface as errors, not silently
      dropped; send still works with the first 10
- [ ] Failed send (kill network before Enter): Retry re-sends the same attachments
      without re-uploading; UI never corrupts

### Mobile upload (client B — on the new APK, runtime 1.1.0)

- [ ] **[BLOCKING]** Paperclip → photo/video picker → upload with progress → send;
      desktop client sees the tile in realtime
- [ ] **[BLOCKING]** Audio file via the document picker uploads and plays in the tile
- [ ] **[BLOCKING]** Geotagged phone photo: send from the phone, download via signed
      URL, `exiftool` shows **no GPS tags** (the expo-image-manipulator EXIF-strip
      claim was never verified on a device — M10-6 report)
- [ ] **[BLOCKING]** Caption-less mobile send renders tile-only on desktop and mobile
- [ ] Remove a chip mid-upload: native upload task cancels, progress stops
- [ ] Airplane-mode a send: failed row's Retry re-sends the same ids

### Both platforms — render + lifecycle

- [ ] Scroll far back through attachment history: tiles keep their reserved boxes
      (no layout shift as images load), pagination doesn't duplicate
- [ ] Leave the app open past ~1 h, scroll back to an old attachment: the tile
      re-signs its URL silently (or shows the quiet Retry affordance — never a raw
      error / broken-image glyph)
- [ ] Backend with Supabase unset: every attachment action shows the friendly
      "Attachments are not available" message; text chat unaffected
- [ ] GIF: animates in the tile, GIF badge shown, pauses when scrolled offscreen
      (desktop); tap/click opens the image lightbox/viewer and it closes cleanly

## Film-night end-to-end (the goal — after deploy)

Two people, two networks (one on mobile cellular), no VPN:
- [ ] Host (desktop) and guest (mobile) both reach the deployed `https://api.<domain>` and sign in
- [ ] Both join the same voice channel and hear each other
- [ ] Host shares a film (screen + audio); guest **sees the video and hears the film** on their phone
- [ ] Sustained watch (10+ min) stays stable; a brief network blip recovers via reconnect
- [ ] Works from a Turkish connection **without a VPN** (the whole point)

## DM calls (ADR 0012 / DM-calls plan Wave 8) — desktop + mobile

Private 1-1 voice / video / screen calls from a DM, gated by mutual friendship, with a
seamless auto-upgrade to a group when a third person is added. Needs a backend with LiveKit
reachable, Redis wired (single-session eviction), the offline notifier configured (push), and
**two mutual-friend accounts** (A caller, B callee) plus a **third friend** (C) for the upgrade
path. Run the desktop set and the mobile set; the two must match feature-for-feature (parity).

### Ring / accept / decline / cancel (the ring lifecycle)

- [ ] **Ring** — A opens the DM with B, taps the **voice** call button; B gets a global
      incoming-call overlay (caller avatar + name) with a ringtone, regardless of B's current
      screen; A sees "Ringing…" with Cancel
- [ ] **Video ring** — A taps the **video** call button; B's overlay offers Accept /
      Accept-with-video / Decline
- [ ] **Accept** — B accepts; both land in the in-call surface, hear each other (audio flows),
      A's ringing state clears; B's ringtone stops
- [ ] **Decline** — fresh call, B declines; A sees "declined", ringing stops on both; the DM shows
      a "Call declined" system message
- [ ] **Cancel** — fresh call, A cancels before B answers; B's overlay/ringtone stops; the DM
      shows a "Call canceled" system message
- [ ] **Timeout → missed** — A calls, nobody answers for the ring window (~30 s); the ring clears
      on both without manual action; the DM shows a "Missed call" system message
- [ ] **Offline callee → missed + push** — B fully offline (app closed); A calls; B receives an
      **offline push** ("<A> is calling you") that deep-links into the ring; if unanswered it logs
      **missed** with the DM system message
- [ ] **Call buttons gated** — after A and B are no longer friends, the DM call buttons are
      disabled with an explanatory tooltip; forcing a start returns a friendly "You can only call
      friends" error (never a raw 403)

### In-call (voice / video / screen — the existing media stage, entered from a DM)

- [ ] **Hang up** — either participant hangs up; the other returns cleanly to the DM; the DM shows
      "Call ended · mm:ss" with a sane duration
- [ ] **Screen share in a call** — during an active call, start screen share via the source picker;
      the peer sees the video **and hears film/system audio**; stop share returns cleanly
- [ ] **Camera on/off in a call** — toggle camera; self-preview and the peer tile update; the
      video-stage focus / maximize / fullscreen / movable PiP all work (same stage as a channel)
- [ ] **Reconnect during a call** — drop A's network mid-call; A shows `reconnecting`, then
      recovers on the **same room** with audio flowing (no full re-join, no "voice server
      unavailable"); if it cannot recover it fails with a clear error and no zombie state
- [ ] **Single-session eviction** — A is in a group voice channel on one device, then accepts a DM
      call on another device (or the same); the group-voice session is evicted cleanly
      (`voice.session_replaced` notice, no error), and A is only ever in one room

### Seamless group upgrade (the founder's firmest ask — audio must never drop)

- [ ] **Add a third person** — during an active A↔B call, A uses **Add person** → friend picker →
      picks C; A and B **stay connected with zero audio gap** (no reconnect, no silence) while
      their UI moves from "DM call" into a new group's voice channel
- [ ] **Third person rings in** — C gets an incoming-call ring for the group; accepting lands C in
      the **same live call** (hears A and B); declining still leaves C a member of the new group
- [ ] **DM history stays private** — after the upgrade, open the original A↔B DM: its message
      history is intact and unchanged; the **new group has its own fresh, empty text stream** (no
      DM messages copied into it)
- [ ] **Upgrade gate** — the inviter must be a mutual friend of C; trying to add a non-friend is
      blocked; C already in the call cannot be re-added

### Abuse / edge cases (security-adjacent — verify these do not misbehave)

- [ ] **Non-friend blocked on every path** — with A and B not friends, start / accept / upgrade
      all refuse (friendly error), even though the DM row still exists from before
- [ ] **Second call → 409 → rejoin** — while a call is live in a DM, starting another call in the
      same DM does not create a duplicate; the client rejoins the existing call
- [ ] **Mid-call unfriend** — A and B in an active call; A unfriends B mid-call; verify **both can
      still hang up / leave cleanly** and the call does not get permanently stuck "in progress"
      (see security report `dm-calls-security.md` — SHOULD-FIX on the terminal-endpoint gate; if
      the fix is not yet in, this item is expected to FAIL and blocks a "hardened" sign-off)
- [ ] **No stray media over WebSocket** — with DevTools open, confirm no audio/video frames cross
      the WS gateway (binary frames are refused); media is LiveKit only

### DM-calls regression list (re-run after any call, media, friendship, or gateway change)

- [ ] A normal (non-call) group voice channel join/leave still works and is unaffected by the
      `livekit_room` override (existing voice channels resolve room = channel id)
- [ ] Presence, typing, and normal DM chat all still work while a call overlay is on screen
- [ ] `call.*` events reach only the intended user(s); a third party never sees a call they are
      not part of, and a restricted channel never leaks via the upgrade's new group
- [ ] Reconnecting the WS mid-call does not duplicate the participant or the DM system message
- [ ] Rapid decline/cancel/hangup taps do not post duplicate system messages (terminal endpoints
      are idempotent: a repeat returns 409, not a second "Call ended")

## Media UX added this cycle (voice-room quality features — desktop + mobile)

Run when a branch touches the voice/video stage, device settings, or audio pipeline.

- [ ] **Per-person volume** — in a voice room with 2+ others, adjust one participant's volume
      slider; only that person's playback changes; the setting persists across mute/unmute
- [ ] **Video layout** — grid ↔ focused/spotlight switch works; focusing/maximizing a camera
      tile, fullscreen, and the movable camera PiP overlay all behave; collapsing cameras while
      screen-sharing works ([[video-stage-requirements]])
- [ ] **Adjustable camera / stream quality** — changing the camera or broadcast quality preset
      (and 60 fps where offered) takes effect for viewers without a full re-join
- [ ] **Self-preview** — the local camera self-view renders and mirrors correctly, and does not
      echo the user's own audio back
- [ ] **System-audio source picker** — when starting screen share, the audio source selection is
      honored (the intended screen/app/system audio is what the viewer hears)
- [ ] **In-app friend notification** — a friend request / accept surfaces an in-app notification
      to the recipient live (no reload), in addition to any offline push

## Identity & account lifecycle + NSFW (M15 — 2026-07-26, desktop + mobile)

Run on BOTH platforms (parity). Backend needs migration 0018 applied; banner/avatar
items need `SUPABASE_AVATAR_BUCKET` set.

### Account deletion / freeze / reactivation (ADR 0014)

- [ ] Delete account (Danger Zone, confirmed) → signed out everywhere; other clients'
      sessions are dead too
- [ ] Plain login on the frozen account → friendly `ACCOUNT_FROZEN` message showing the
      purge deadline, NOT a raw error
- [ ] Login again with the reactivate option → account restored, groups/messages/DMs intact
- [ ] Dev-only purge check: set `purge_at` to the past in the DB → within the hour (or by
      triggering the job) the user's messages show "Deleted User", profile is scrubbed,
      login is impossible; other members' channels/servers unaffected

### Birthdate set-once (ADR 0014)

- [ ] Register with a birthdate → settings shows it read-only; no second edit offered
- [ ] Pre-M15 account (no birthdate): can set it ONCE in settings; a second write attempt
      is refused with a friendly message (`409 BIRTHDATE_LOCKED`), not a raw 409
- [ ] Birthdate never appears on another user's profile card (me-only; only the 18+ gate
      behavior is observable)

### NSFW channels (ADR 0015)

- [ ] Create a channel with NSFW on; toggle it on/off later in channel settings; the
      channel list shows the 18+ marker
- [ ] Account without birthdate / under 18: entering the NSFW channel is hard-blocked
      with the "add your birthdate in settings" guidance
- [ ] Adult account: first entry shows the 18+ confirmation once; re-entry does not
      re-ask (per-channel memory)
- [ ] With `MEDIA_MODERATION_MODE=off` (default): image uploads succeed everywhere —
      nothing is ever rejected for NSFW (fail-open is the intended posture)

### Profile banner + avatar upload

- [ ] Upload an avatar (photo ≤2 MB) and a banner (gif or static ≤5 MB) → both render on
      the profile card without reload; oversize files get a friendly rejection upfront
- [ ] Backend with `SUPABASE_AVATAR_BUCKET` unset → both uploads show the friendly
      "uploads not available" message (503), never a raw error

### Film-audio quality (#113 — real devices, not emulator)

- [ ] Desktop shares a film with system audio; a second desktop AND a mobile listener
      hear stereo, full-range sound (music profile: 256 kbps stereo, DTX off)
- [ ] Quiet passages are NOT gated to silence (DTX off — the old speech profile clipped
      soft film audio); no channel collapse to mono
- [ ] Voice chat during the share still sounds normal (mic profile unchanged)

## Reporting

Any failed item blocks merge. Note the failure, the repro steps, and the owning agent
in the handoff note — never merge around a red item.
