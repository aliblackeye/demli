/**
 * @demli/client-core — the shared wire-protocol transport (ADR 0002).
 *
 * One implementation of the HTTP + realtime clients for desktop AND mobile:
 *
 * - api-client.ts     — createApiClient({ baseUrl }) + ApiClientError,
 *                        friendlyErrorMessage, request DTOs.
 * - realtime-client.ts — RealtimeClient (handshake, zod-validated envelopes,
 *                        seq-gap detection, backoff reconnect).
 * - client-gate.ts    — the ONE recogniser for "the server has retired this
 *                        build": HTTP 426 `CLIENT_UPDATE_REQUIRED` and gateway
 *                        close 4426, plus an (unbound) latched holder. Two
 *                        transports, one event, one module — so desktop and
 *                        mobile cannot disagree about what a refusal is.
 * - token-storage.ts  — the TokenStorage persistence seam (per-app impl).
 * - upload.ts         — uploadToSignedUrl: XHR direct-to-storage PUT with
 *                        progress (ADR 0008 attachment upload, step 2).
 * - id.ts             — IdGenerator + a crypto.randomUUID-based default.
 * - attachment-url-resolver.ts — batching/expiry cache for signed attachment
 *                        read URLs (ADR 0008 §5), framework-free.
 * - markdown.ts       — parseMessageMarkdown: the shared, React/DOM-free message
 *                        formatting tokenizer both clients render identically.
 * - mentions.ts       — composer-side @mention helpers (query detect, candidate
 *                        rank, send serialize / edit deserialize) shared by both.
 * - user-names.ts     — resolveUserName: the ONE implementation of the
 *                        private-nickname → server-nickname → displayName order
 *                        (ADR 0019 §2), so no surface can drift on it.
 * - voice-channel-chat.ts — the M20 "a voice channel is a room WITH a
 *                        conversation" rules: what activating its row does
 *                        (join, except the room you are already in), which room
 *                        entry its menu offers, and which controls its chat
 *                        header shows. Shared so desktop/web and mobile cannot
 *                        drift on the founder's most-used voice gesture.
 * - channel-order.ts  — the M18 category placement model: sidebar buckets
 *                        (uncategorized first), the nudge/move gestures, the
 *                        dense-position reorder payload, and WHICH management
 *                        entries a category header / channel row may offer.
 *                        Moved out of @demli/app-ui (react-dom only) so the
 *                        React Native channel list reads the SAME arithmetic
 *                        instead of a second copy that drifts.
 * - channel-invite.ts — who may mint a SERVER invite (the `invite_policy` gate,
 *                        mirroring the API so a member without the permission is
 *                        offered no invite control at all), plus the defensive
 *                        read of an invite's optional `targetChannel` so a client
 *                        that ships ahead of the API degrades to a plain server
 *                        invite instead of crashing on a missing field.
 * - sidebar-visibility.ts — the ONE hide rule behind both "collapse a section"
 *                        and "hide muted channels": whatever else is hidden, the
 *                        channel you are reading and the voice room you are
 *                        connected to always stay on screen.
 * - group-chat-invite.ts — who may mint and who may revoke a group-DM invite
 *                        link (any member / owner ONLY), plus the shared
 *                        expiry+uses arithmetic. The link itself is built by each
 *                        app's deep-link module — one redeem endpoint, one format.
 * - member-menu.ts    — memberMenuGroups: WHICH user-menu entries a viewer may
 *                        see for a target, and in what order. Right-click on
 *                        desktop/web, long-press on mobile, one set of rules —
 *                        so "never offer what the server would refuse" (§35) is
 *                        decided once instead of per renderer.
 * - voice-announcer.ts — the voice.join / voice.leave reconcile both apps run
 *                        against the gateway, including the bounded retry of a
 *                        join the gateway refused (DM → group upgrade race).
 * - dm-calls/         — the DM-call FSM + controller (ADR 0012 Wave 5): a thin,
 *                        framework-free call lifecycle above the voice FSM, driven
 *                        by the `call.*` events and the `/dm-calls/*` endpoints.
 * - account-vault/    — the multi-account vault + switch-reset contract (ADR 0013,
 *                        M15): a storage-backed account registry plus the ordered
 *                        teardown+bringup that leaves no "zombie session" behind.
 * - custom-status.ts  — the M18 status-line rules: what "30 min / 1 hour /
 *                        today" means as `expiresInMinutes` (local midnight,
 *                        never the server's), and whether a stored status is
 *                        still showable. Shared so an expired line cannot keep
 *                        rendering on one surface and not the other.
 * - age-gate.ts       — the 18+ decisions: what an NSFW channel shows a viewer
 *                        (verify here / permanently blocked / acknowledge) and
 *                        whether the one-time "verify your age" nudge is due.
 *                        Framework-free so both renderers gate identically.
 * - watch-party.ts    — the M20 Watch Party client model (ADR 0016): where the
 *                        playhead SHOULD be, whether a drift is worth a seek
 *                        (and the hysteresis/backoff that stops a seek loop
 *                        during an ad), who may drive, and the ONE place an
 *                        embed URL is built. Every number in it — the 2 s
 *                        tolerance, the 3 s quiet period, the 3→6→9→12 backoff,
 *                        the ≤0.5 s clock-skew allowance — has to be IDENTICAL
 *                        on every surface or two members of the same room
 *                        correct each other forever, so there is one copy.
 * - watch-player-protocol.ts — the YouTube iframe `postMessage` wire: command
 *                        frames out, defensive parse in, and the error taxonomy.
 *                        String in, typed value out, no DOM — the transport
 *                        (iframe on desktop/web, WebView on mobile) is the
 *                        caller's business, the grammar is not.
 * - notify-policy.ts  — WHEN an alert may interrupt: suppress ONLY while the
 *                        user is demonstrably looking at the conversation it is
 *                        about, never merely because the app is in the
 *                        foreground. Both platforms bind their own
 *                        `VisibleContext` (desktop: document focus/hidden;
 *                        mobile: AppState + the FOCUSED chat route) and share
 *                        the decision, so the desktop bug — "app open on
 *                        #general, DM arrives, nothing happens" — cannot be
 *                        re-derived differently on the phone.
 * - self-presence.ts  — how a presence frame about the client's OWN user is
 *                        applied: drop a self `offline` (never true on a live
 *                        socket — it is what a pre-M16 gateway's peer mask told an
 *                        invisible user), and strip self from the handshake
 *                        snapshot. Shared so both apps' own dot obeys one rule.
 * - forms/            — zod issue → `{ key, params }`: the ONE place that knows
 *                        which i18n key each validation failure maps to, so a
 *                        broken rule shows the rule instead of "something went
 *                        wrong" (ADR 0009 — keys here, strings in the catalogs).
 *
 * No React, DOM-only globals, Electron, or Node-only imports — depends only on
 * @demli/{types,protocol,config} and zod, all RN-safe. The per-app glue that
 * wires these into concrete stores (zustand/TanStack Query) stays in each app.
 */

export * from "./api-client.js";
export * from "./client-gate.js";
export * from "./realtime-client.js";
export * from "./token-storage.js";
export * from "./storage-keys.js";
export * from "./upload.js";
export * from "./id.js";
export * from "./attachment-url-resolver.js";
export * from "./reply-preview.js";
export * from "./markdown.js";
export * from "./mentions.js";
export * from "./user-names.js";
export * from "./member-menu.js";
export * from "./channel-order.js";
export * from "./channel-invite.js";
export * from "./sidebar-visibility.js";
export * from "./group-chat-invite.js";
export * from "./voice-channel-chat.js";
export * from "./age-gate.js";
export * from "./custom-status.js";
export * from "./unread.js";
export * from "./notify-policy.js";
export * from "./self-presence.js";
export * from "./watch-party.js";
export * from "./watch-player-protocol.js";
export * from "./outbox/index.js";
export * from "./dm-calls/index.js";
export * from "./voice-announcer.js";
export * from "./account-vault/index.js";
export * from "./forms/index.js";
