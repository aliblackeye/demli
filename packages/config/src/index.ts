/**
 * Shared runtime configuration constants and defaults.
 * Environment parsing (zod-based) is added when the API grows in Milestone 2.
 */

/**
 * Image header inspection (magic-byte sniffing + the decompression-bomb budget).
 * Re-exported from the package root because it is a rule every surface needs and
 * this package is the only dependency-free leaf both `apps/api` and
 * `packages/app-ui` can import. See `./image-bytes.ts` for why it lives here.
 */
export * from "./image-bytes.js";

/**
 * Client-identity gate — the header/query-param
 * mark, the refusal codes, and the two predicates the API, the WS gateway and
 * the clients must all agree on. Re-exported from the package root for the same
 * reason as the image rules above: this is the only dependency-free leaf every
 * one of those surfaces can import. See `./client-gate.ts`.
 */
export * from "./client-gate.js";

export const APP_NAME = "Demli";

export const DEFAULT_API_PORT = 4000;
export const DEFAULT_REALTIME_PORT = 4001;

export const MESSAGE_MAX_LENGTH = 4000;
export const GROUP_NAME_MAX_LENGTH = 64;
export const CHANNEL_NAME_MAX_LENGTH = 64;
export const USERNAME_MAX_LENGTH = 32;

// ---------------------------------------------------------------------------
// Form / request field limits — the SINGLE source of truth for every number a
// user-facing form and its server-side schema both have to know.
//
// These existed before, but as copies: `DISPLAY_NAME_MAX_LENGTH = 48` in the
// desktop profile screen, `64` in the API, `64` again in the mobile profile
// screen; the channel description was `280` in the desktop dialog and `512` in
// the API; the FriendsView username input said `maxLength=64` while the real
// username limit is 32. A user who typed a legal-looking value got a 400 with no
// usable message, because a drifted limit produces a rule nobody can see.
//
// So every bound below is declared exactly once, here, in the dependency-free
// leaf that the API, the gateway, the desktop renderer, the web SPA and the RN
// app can all import (the same reasoning as ATTACHMENT_LIMITS above). The zod
// schemas built on them live in `@demli/protocol`'s `requests/` directory,
// and the i18n keys their failures map to live in `@demli/client-core`'s
// `forms/issue-to-error.ts`.
// ---------------------------------------------------------------------------

/** Username floor. Short enough to be claimable, long enough not to be noise. */
export const USERNAME_MIN_LENGTH = 3;

/**
 * The username grammar: ASCII letters, digits and underscore.
 *
 * Deliberately narrow, for the same reason as the custom-emoji grammar: a
 * username is an IDENTITY key that is compared, mentioned and typed by other
 * people. Unicode would let `аli` (Cyrillic а) impersonate `ali`, and a space or
 * a `@` would break the `@mention` and add-by-username flows. Usernames are
 * lowercased before storage, so the pattern accepts both cases and the transform
 * normalizes.
 */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_]+$/;

/**
 * Usernames nobody may register or rename INTO.
 *
 * `everyone` and `here` are the load-bearing entries: `@everyone` / `@here` are
 * broadcast mention targets (see `@demli/protocol`'s mentions module), so a
 * user holding one of those names would make every mention of them ambiguous
 * with a server-wide ping. The rest are the ordinary impersonation set — an
 * `admin` or `support` account in a friend group is a phishing handle — plus the
 * brand names and the three string literals (`null`, `undefined`, `deleted`)
 * that show up when a name is rendered from a missing value.
 *
 * Checked ONLY on register and rename. Existing accounts are never re-validated:
 * an account that predates this list keeps working, because retro-invalidating a
 * name would lock a real user out of their own account with no way to fix it.
 */
export const RESERVED_USERNAMES = [
  "admin",
  "administrator",
  "mod",
  "moderator",
  "root",
  "system",
  "support",
  "staff",
  "owner",
  "demli",
  "everyone",
  "here",
  "me",
  "null",
  "undefined",
  "deleted",
] as const;

/** One of the {@link RESERVED_USERNAMES}. */
export type ReservedUsername = (typeof RESERVED_USERNAMES)[number];

const RESERVED_USERNAME_SET: ReadonlySet<string> = new Set(RESERVED_USERNAMES);

/**
 * True when `username` is reserved. Case-insensitive — usernames are stored
 * lowercased, so `Everyone` and `everyone` are the same name.
 */
export function isReservedUsername(username: string): boolean {
  return RESERVED_USERNAME_SET.has(username.toLowerCase());
}

/**
 * Password length window for REGISTRATION.
 *
 * 8 characters and a breached-password denylist, and nothing else — no "must
 * contain an uppercase letter and a digit". That is NIST SP 800-63B's
 * recommendation (§5.1.1.2) and it is the rule that actually helps: composition
 * requirements push people to `Password1!`, which is on every cracking list,
 * while blocking a long memorable passphrase for having no symbol. The 128 cap
 * exists only so a password field cannot become an unbounded upload; argon2id
 * hashes any length.
 *
 * LOGIN deliberately does NOT use these — see `PASSWORD_LOGIN_MIN_LENGTH`.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Password floor for LOGIN: 1. **Do not raise this.**
 *
 * Login validates that a password was TYPED, never that it is a good one. Every
 * account created before a rule existed still has to be able to sign in — if
 * login enforced the registration minimum, every user whose password predates it
 * would be locked out of their own account by a client-side form, with no path
 * to the password-change screen that lives behind the login. The only bound
 * login shares with registration is the 128 ceiling.
 */
export const PASSWORD_LOGIN_MIN_LENGTH = 1;

/** Display name: 1..64. Unicode is free here — real names are not ASCII. */
export const DISPLAY_NAME_MAX_LENGTH = 64;

/** Profile bio (ADR 0010 §3). Multiline; line breaks are kept. */
export const BIO_MAX_LENGTH = 280;

/** Custom status (M18) — one short line under the name, tighter than the bio. */
export const CUSTOM_STATUS_MAX_LENGTH = 128;

/** Longest a custom status may be scheduled to live (7 days, in minutes). */
export const CUSTOM_STATUS_MAX_MINUTES = 7 * 24 * 60;

/** Channel topic/description (0003_channel_meta). */
export const CHANNEL_DESCRIPTION_MAX_LENGTH = 512;

/** Voice-channel participant cap. LiveKit-sensible upper bound. */
export const CHANNEL_MAX_PARTICIPANTS = 99;

/** Slowmode ceiling — 6 hours (0004_system_slowmode). */
export const CHANNEL_SLOWMODE_MAX_SECONDS = 21_600;

/**
 * Opus-sensible voice bitrate window in kbps (0004_system_slowmode).
 *
 * This is the VALIDATION window, deliberately wider than what the UI offers (see
 * {@link AUDIO_BITRATE_PRESETS_KBPS}). It must stay wide: channels configured
 * before the preset UI landed may hold any value in this range, and narrowing the
 * schema would make those channels un-saveable (and silently rewrite a value the
 * owner chose). Server-side: accept the whole window. UI-side: offer the presets.
 */
export const AUDIO_BITRATE_MIN_KBPS = 8;
export const AUDIO_BITRATE_MAX_KBPS = 510;

/**
 * The channel bit-rate CHOICES offered in the UI (founder, 2026-07-28: "kanalların
 * bit hızı olsun. 8kbps 64kbps ve 128kbps arası olsun").
 *
 * Three named steps instead of a free number field: a raw kbps box asks the user a
 * question they have no way to answer, and values far above 128 burn uplink for no
 * audible gain on speech (Opus is transparent for voice well below that). The
 * SINGLE SOURCE for both the picker and any validation that wants to know "is this
 * one of the offered values" — never re-type these numbers in a component.
 *
 * Ordered lowest → highest so a UI can map them straight onto a row of buttons.
 */
export const AUDIO_BITRATE_PRESETS_KBPS = [8, 64, 128] as const;

/** One of the three offered channel bit-rate steps. */
export type AudioBitratePresetKbps = (typeof AUDIO_BITRATE_PRESETS_KBPS)[number];

/**
 * Whether a stored bitrate is one of the offered presets. A channel whose value is
 * NOT a preset (set before this UI, or via the API) is still perfectly valid — the
 * UI must show it honestly as a custom value rather than snapping it to the nearest
 * preset, which would silently change the owner's configuration on open.
 */
export function isAudioBitratePreset(kbps: number): kbps is AudioBitratePresetKbps {
  return (AUDIO_BITRATE_PRESETS_KBPS as readonly number[]).includes(kbps);
}

/** Sidebar category name (M18) — a header, not a description. */
export const CATEGORY_NAME_MAX_LENGTH = 64;

/** Role name bounds (ADR 0007: 1..32 chars). */
export const ROLE_NAME_MAX_LENGTH = 32;

/** `#rrggbb` role colour. Hex only — the UI needs a parseable value, not CSS. */
export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Safety cap on role-id lists (assignment sets, channel access lists). */
export const ROLE_ID_LIST_MAX = 100;

/** Safety cap on the id lists a single channel/category reorder may carry. */
export const REORDER_LIST_MAX = 500;

/** Max length of the optional moderator ban note. */
export const BAN_REASON_MAX_LENGTH = 512;

// ---------------------------------------------------------------------------
// Member context menu — private annotations, nicknames, timeout (migration 0020)
//
// Four bounds for the right-click actions that had no backend before: a private
// note, the two KINDS of nickname (see ADR 0019 for why there are two), and the
// timeout window. All live here for the same reason as every other bound above —
// the form that types the value and the endpoint that stores it must enforce the
// same rule, or the user gets a 400 for a value the field let them type.
// ---------------------------------------------------------------------------

/**
 * Private note about another user (`user_notes.body`).
 *
 * 256 rather than the bio's 280: a note is a reminder ("met at the LAN party",
 * "Burak's alt"), not prose. Short enough that the profile card can render it
 * whole with no truncation branch, which matters because this is the ONE surface
 * that ever displays it (ADR 0019 §1).
 */
export const USER_NOTE_MAX_LENGTH = 256;

/**
 * Personal nickname for another user (`user_nicknames.nickname`) — the one only
 * YOU see. Matches {@link MEMBER_NICKNAME_MAX_LENGTH} deliberately: both stand in
 * for a display name in exactly the same slots, so a name that fits one must fit
 * the other. They are separate constants rather than one shared value because
 * they are separate product rules that merely agree today.
 */
export const USER_NICKNAME_MAX_LENGTH = 32;

/**
 * Per-server nickname (`friend_group_members.nickname`) — the one EVERYONE in
 * that server sees. Same bound as the personal one; see above.
 */
export const MEMBER_NICKNAME_MAX_LENGTH = 32;

/**
 * Timeout (mute) window in minutes: 1 minute .. 28 days.
 *
 * The ceiling is a real bound, not a formality: a timeout
 * is a COOL-OFF, and one that can be set to a year is a ban wearing a different
 * label — with none of a ban's audit weight or its "the target is told" contract.
 * Beyond 28 days the right tool is a kick or a ban.
 */
export const TIMEOUT_MIN_MINUTES = 1;
export const TIMEOUT_MAX_MINUTES = 28 * 24 * 60;

/** Invite code bounds, applied AFTER a pasted link is parsed down to the code. */
export const INVITE_CODE_MIN_LENGTH = 4;
export const INVITE_CODE_MAX_LENGTH = 64;

/** Invite expiry window in hours: 1 hour .. 30 days. Omitted = never expires. */
export const INVITE_EXPIRES_HOURS_MIN = 1;
export const INVITE_EXPIRES_HOURS_MAX = 24 * 30;

/** Invite redemption cap. Omitted = unlimited. */
export const INVITE_MAX_USES_MIN = 1;
export const INVITE_MAX_USES_MAX = 100;

/** Avatar / banner / server-icon URL cap. */
export const MEDIA_URL_MAX_LENGTH = 512;

/** Client-declared device label shown in the active-sessions list (M15-A). */
export const DEVICE_NAME_MAX_LENGTH = 120;

/** Expo push token cap. */
export const PUSH_TOKEN_MAX_LENGTH = 256;

/** Opaque keyset pagination cursor cap (messages, moderation log, call history). */
export const CURSOR_MAX_LENGTH = 512;

/** Message-search query bounds (ADR 0011 §5). Under 3 chars is not a useful match. */
export const SEARCH_QUERY_MIN_LENGTH = 3;
export const SEARCH_QUERY_MAX_LENGTH = 128;

/** Declared MIME / filename caps on an upload body. Hints only — bytes are sniffed. */
export const MIME_MAX_LENGTH = 255;
export const FILENAME_MAX_LENGTH = 255;

/**
 * Earliest accepted year of birth. 1901 rather than a computed "today minus 120"
 * so the bound is a constant rather than a moving target that would invalidate a
 * stored value as the clock advances.
 *
 * There is NO minimum-age rule here on purpose: whether Demli refuses under-13
 * (COPPA) or under-16 (GDPR Art. 8) sign-ups is a product/legal decision for the
 * founder, not an engineering default (CLAUDE.md §33). The stored birthdate
 * already drives the NSFW age gate; a sign-up floor would be an additional rule.
 */
export const BIRTH_YEAR_MIN = 1901;

// ---------------------------------------------------------------------------
// Media attachments (ADR 0008 / M10) — the SINGLE source of truth for the
// type whitelist and size caps. The client validates locally for a fast reject
// and the API re-validates authoritatively; both import THESE constants so the
// two never drift (CLAUDE.md §23 — no magic numbers, one source of truth).
//
// Kept in @demli/config (a dependency-free leaf) rather than @demli/types
// so the API, gateway, desktop renderer and mobile app can all consume the
// limits without pulling the domain-type package. The runtime `attachment_kind`
// set lives in @demli/types as `ATTACHMENT_KINDS`; @demli/protocol asserts
// at compile time that the keys below match that union exactly.
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;

/** Max attachments carried by a single message (ADR 0008 §4). */
export const ATTACHMENT_MAX_PER_MESSAGE = 10;

/**
 * Per-kind MIME whitelist + byte cap (ADR 0008 §4). Whitelist is by exact MIME;
 * the API additionally magic-byte-sniffs the bytes on `complete`, since a direct
 * client upload cannot be trusted on declared MIME alone. **SVG is deliberately
 * excluded** (stored-XSS vector). Keys are exactly the `attachment_kind` enum.
 */
export const ATTACHMENT_LIMITS = {
  image: {
    maxBytes: 10 * MB,
    mimes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  },
  audio: {
    maxBytes: 20 * MB,
    mimes: ["audio/mpeg", "audio/ogg", "audio/wav"],
  },
  video: {
    maxBytes: 100 * MB,
    mimes: ["video/mp4", "video/webm"],
  },
} as const satisfies Record<string, { maxBytes: number; mimes: readonly string[] }>;

/** A whitelisted attachment kind key, structurally `"image" | "audio" | "video"`. */
export type AttachmentLimitKind = keyof typeof ATTACHMENT_LIMITS;

// ---------------------------------------------------------------------------
// Message enrichment (ADR 0011 / M14) — emoji reactions & replies.
//
// `REACTION_EMOJI` is the QUICK-react palette — the small common set a compact
// surface (the mobile action sheet) may still offer as one-tap chips. It is NO
// LONGER the whitelist of what may be reacted with: a reaction key is accepted
// when it is EITHER any single unicode emoji OR a `:name:` custom-emoji shortcode
// that resolves to an emoji uploaded to the message's group (M17). The
// AUTHORITATIVE gate is on the API (`apps/api/src/lib/reaction-emoji` for the
// unicode half + a per-group custom-emoji lookup for the `:name:` half); the two
// structural helpers a client may share — {@link parseCustomEmojiShortcode} and
// {@link REACTION_KEY_MAX_LENGTH} — live here in this dependency-free leaf.
//
// The precise unicode-emoji test needs the `v`-flag `\p{RGI_Emoji}` property,
// which is a PARSE error on older browser engines (Safari 12 / iOS 12, the web
// target); it therefore stays on the API (Node ≥ 20), never in this leaf, which
// is bundled into the browser client.
//
// The reactions column is plain `text`, so this widening needed NO migration —
// only the API validator relaxed.
// ---------------------------------------------------------------------------

/** The MVP quick-react palette (ADR 0011 §1) — a common one-tap subset, NOT the whitelist. */
export const REACTION_EMOJI = ["👍", "❤️", "😂", "🎉", "😮", "😢", "🙏", "🔥"] as const;

/** One of the quick-react palette emoji, e.g. `"👍"`. */
export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

/**
 * Coarse upper bound on a reaction key's length on the wire (the `:emoji` route
 * segment / the reactions column). A unicode emoji sequence — even a long ZWJ
 * family — and a `:name:` shortcode (name ≤ 32) both fit well under this; it is
 * only a guard so the segment can never carry unbounded text. The REAL gate is
 * the API's shape/lookup validation, not this length.
 */
export const REACTION_KEY_MAX_LENGTH = 64;

/**
 * Chars of a reply target's content carried in the denormalized reply preview
 * (ADR 0011 §2). A quote only needs a short lead-in; the client resolves the
 * author name from its users map, so the preview stays lean.
 */
export const REPLY_PREVIEW_MAX = 120;

// ---------------------------------------------------------------------------
// Pinned messages (M17) — a per-channel pin board.
//
// A hard per-channel cap keeps the pin list a single un-paginated read: the
// endpoint returns every pin in one response, so no cursor machinery is needed
// and the panel can never become an unbounded scroll (§27). The API enforces
// this authoritatively (a 51st pin is a 409); clients import the same constant
// to disable the action and explain why, so the two never drift (§23).
// ---------------------------------------------------------------------------

/** Max pinned messages per channel. */
export const PINS_MAX_PER_CHANNEL = 50;

// ---------------------------------------------------------------------------
// Custom emoji (M17) — per-group emoji uploaded by members, referenced in
// message content as `:name:`.
//
// The SINGLE source of truth for the name grammar, MIME whitelist, byte cap and
// per-group count, exactly like `ATTACHMENT_LIMITS`: the client validates
// locally for a fast reject and the API re-validates authoritatively on the REAL
// bytes (magic-byte sniff), so a client can never widen the rules (§28).
//
// **SVG and GIF are deliberately excluded.** SVG is a stored-XSS vector (it is
// markup, not an image); GIF is excluded because an animated emoji inline in
// every message row is a render-cost trap (§27) — the cap is deliberately small
// so emoji stay cheap to decode in a virtualized list.
// ---------------------------------------------------------------------------

/** Max custom emoji a single group may hold. */
export const CUSTOM_EMOJI_MAX_PER_GROUP = 64;

/** Byte cap for one uploaded emoji image (256 KB). */
export const CUSTOM_EMOJI_MAX_BYTES = 256 * 1024;

/** Exact MIME whitelist for emoji uploads. No SVG (XSS), no GIF (render cost). */
export const CUSTOM_EMOJI_MIMES = ["image/png", "image/webp"] as const;

/** One of the whitelisted emoji MIME types. */
export type CustomEmojiMime = (typeof CUSTOM_EMOJI_MIMES)[number];

export const CUSTOM_EMOJI_NAME_MIN_LENGTH = 2;
export const CUSTOM_EMOJI_NAME_MAX_LENGTH = 32;

/**
 * The emoji-name grammar: lowercase ASCII letters, digits and underscore only.
 *
 * Deliberately narrow. The name is the ENTIRE key by which `:name:` in message
 * content resolves to an image, so it must be unambiguous under the shortcode
 * scanner: no colons (which would break the delimiter), no whitespace, no
 * unicode look-alikes (a homoglyph name could impersonate another emoji), and no
 * case (names are compared case-insensitively and stored lowercased, so `:Cat:`
 * and `:cat:` are the same emoji and cannot both exist in one group).
 */
export const CUSTOM_EMOJI_NAME_PATTERN = /^[a-z0-9_]{2,32}$/;

/**
 * True when `name` is a legal custom-emoji name. The API's authoritative guard
 * on upload; clients use it to validate the field before sending. Callers must
 * lowercase first — the pattern rejects uppercase rather than silently accepting
 * it, so a caller that forgets normalization gets a validation error, not two
 * colliding emoji.
 */
export function isCustomEmojiName(name: string): boolean {
  return CUSTOM_EMOJI_NAME_PATTERN.test(name);
}

/**
 * True when `mime` is a whitelisted emoji image type. The declared MIME is only
 * the first gate — the API additionally magic-byte-sniffs the uploaded bytes,
 * since a declared content type is client-supplied and therefore untrusted.
 */
export function isCustomEmojiMime(mime: string): mime is CustomEmojiMime {
  return (CUSTOM_EMOJI_MIMES as readonly string[]).includes(mime);
}

/**
 * True when `v` is exactly one of the {@link REACTION_EMOJI} quick-react palette.
 * A plain literal-set membership test — the fast "known-good common emoji" path.
 * It is NO LONGER the full reaction gate: the API additionally accepts any single
 * unicode emoji and any resolvable `:name:` custom emoji (see this section's note).
 */
export function isReactionEmoji(v: string): v is ReactionEmoji {
  return (REACTION_EMOJI as readonly string[]).includes(v);
}

/**
 * If `v` is a `:name:` custom-emoji shortcode, return its inner name (the
 * lowercased-grammar key an emoji is stored under); otherwise `null`.
 *
 * Deliberately a plain-string + {@link isCustomEmojiName} check with NO exotic
 * regex flags, so it is safe to bundle into the browser client (unlike the
 * `v`-flag unicode-emoji test, which stays API-only). The API composes this with
 * a per-group lookup to authorize a custom-emoji reaction; a client uses it to
 * tell a `:name:` reaction from a unicode one when rendering the badge.
 */
export function parseCustomEmojiShortcode(v: string): string | null {
  // Shortest legal shortcode is `:` + a 2-char name + `:`.
  if (v.length < CUSTOM_EMOJI_NAME_MIN_LENGTH + 2) return null;
  if (v[0] !== ":" || v[v.length - 1] !== ":") return null;
  const name = v.slice(1, -1);
  return isCustomEmojiName(name) ? name : null;
}

/**
 * Resolve the attachment kind a MIME belongs to, or `null` if it is not
 * whitelisted. This is the ONE canonical MIME→kind mapping — the API derives an
 * upload's kind from it and the client maps a kind to a render component, so a
 * security-relevant classification never diverges between the two.
 */
export function attachmentKindForMime(mime: string): AttachmentLimitKind | null {
  for (const kind of Object.keys(ATTACHMENT_LIMITS) as AttachmentLimitKind[]) {
    if ((ATTACHMENT_LIMITS[kind].mimes as readonly string[]).includes(mime)) {
      return kind;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Watch Party (M20, ADR 0016)
//
// Everyone plays the video from YouTube themselves; the server only syncs
// play/pause/seek/host state over the WS gateway. The one value that crosses the
// trust boundary is the video reference, and it ends up inside an iframe `src`
// on every client — so the parser below is a SECURITY control, not a
// convenience: nothing that fails it may ever be stored or broadcast.
// ---------------------------------------------------------------------------

/**
 * A YouTube video id: exactly 11 URL-safe characters. Anchored, fixed length,
 * and free of `.`/`/`/`:`/`?`/`&`/`%` — so an id that passes this can never
 * escape the path segment it is interpolated into, whichever embed URL a client
 * builds. This is the ONLY shape the server stores or puts on the wire.
 */
export const WATCH_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/**
 * Longest client-supplied video REFERENCE — a bare id or a full YouTube URL
 * (`watch?v=`, `youtu.be/…`, `/embed/…`, `/shorts/…`, `/live/…`). Bounded so a
 * hostile frame cannot hand the parser a megabyte of "URL"; a real YouTube link
 * with tracking parameters stays well under it.
 */
export const WATCH_VIDEO_REF_MAX_LENGTH = 256;

/**
 * Upper bound on any playback position, in seconds (24 h). Bounds the payload
 * and keeps a hostile `seek` from parking a session at 1e300 seconds, where
 * every client's player would clamp differently.
 */
export const WATCH_POSITION_MAX_SECONDS = 86_400;

/**
 * How often the server re-states an active session to the room (ADR 0016 "sync
 * drift"). Ads play per-viewer and no two players tick identically, so the
 * server's position is periodically restated and clients that have drifted seek
 * back. 5 s is frequent enough that a drift never grows past a few seconds and
 * rare enough to be invisible next to the chat fan-out.
 */
export const WATCH_HEARTBEAT_MS = 5_000;

/**
 * Idle lifetime of the Redis session record. The session is ephemeral by design
 * (ADR 0016: no DB table in MVP) — it normally ends when the host stops it or
 * the voice channel empties, and this TTL is only the backstop that keeps a
 * record from outliving the gateway that made it.
 */
export const WATCH_SESSION_TTL_SECONDS = 12 * 60 * 60;

/**
 * How far a client's player may drift from the server position before it seeks
 * (ADR 0016). Lives here so both platforms correct at the same threshold — a
 * client that re-seeks on every 200 ms of jitter would stutter permanently.
 */
export const WATCH_DRIFT_TOLERANCE_SECONDS = 2;

/** Hostnames whose URLs may carry a video id. Exact match — no prefix logic. */
const YOUTUBE_HOSTS = [
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
] as const;

/** Path prefixes that carry the id as the segment right after them. */
const YOUTUBE_ID_PATH_PREFIXES = ["embed", "shorts", "live", "v"] as const;

/** True when `value` is exactly a YouTube video id (see the pattern's note). */
export function isYouTubeVideoId(value: string): boolean {
  return WATCH_VIDEO_ID_PATTERN.test(value);
}

/**
 * Normalize a client-supplied video reference to a bare YouTube video id, or
 * `null` when it is not one.
 *
 * Accepts a bare id or any ordinary YouTube link, because "paste a link" is the
 * MVP interaction (ADR 0016) — but the parse runs on the SERVER and the result
 * is re-checked against {@link WATCH_VIDEO_ID_PATTERN}, so the only thing that
 * can ever reach storage or the wire is 11 safe characters. Nothing here trusts
 * the input: an unknown host, a missing/oversized id, a `javascript:` scheme, a
 * lookalike domain (`youtube.com.evil.test`) and a URL with the id smuggled into
 * a fragment all return `null` rather than a "best guess".
 *
 * Exported from config (not the gateway) so the player UI can pre-validate a
 * pasted link with the SAME rule the server enforces — one grammar, two callers,
 * no drift.
 */
export function parseYouTubeVideoId(ref: string): string | null {
  const trimmed = ref.trim();
  if (trimmed.length === 0 || trimmed.length > WATCH_VIDEO_REF_MAX_LENGTH) return null;
  // The common case: already an id.
  if (isYouTubeVideoId(trimmed)) return trimmed;

  // A scheme-less link ("youtu.be/xxx") is what a paste often looks like; give
  // it https so `new URL` can parse it. Anything that still fails to parse — or
  // parses to a non-http(s) scheme like `javascript:` — is rejected outright.
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  if (!(YOUTUBE_HOSTS as readonly string[]).includes(host)) return null;

  // Non-empty path segments; `/embed/ID` and `youtu.be/ID` both reduce to this.
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const isShortLink = host === "youtu.be" || host === "www.youtu.be";

  let raw: string | null = null;
  if (isShortLink) {
    raw = segments[0] ?? null;
  } else if (segments.length === 0 || segments[0] === "watch") {
    raw = url.searchParams.get("v");
  } else if ((YOUTUBE_ID_PATH_PREFIXES as readonly string[]).includes(segments[0] ?? "")) {
    raw = segments[1] ?? null;
  }

  // The final gate. Whatever route produced `raw`, it becomes a video id only by
  // passing the same anchored pattern a bare id must pass.
  return raw !== null && isYouTubeVideoId(raw) ? raw : null;
}

// ---------------------------------------------------------------------------
// Watch Party — QUEUE (M20 wave 2, ADR 0016)
//
// The queue lives inside the same ephemeral Redis session as the playhead, so it
// dies with the party rather than outliving the room that gave it meaning. These
// bounds are the reason it can: a queue nobody caps is a Redis record nobody can
// size and a fan-out nobody can budget (§27).
// ---------------------------------------------------------------------------

/**
 * Longest a queue may get. 50 videos is roughly a night's worth of watching and
 * bounds the one place this feature could otherwise grow without limit: the
 * session record (re-serialized on every control) and the `watch.queue_updated`
 * frame (sent whole, because a queue-diff protocol would be far more code to get
 * wrong than 50 short rows are to resend). An add past this is REFUSED with
 * `WATCH_QUEUE_FULL`, never silently dropped.
 */
export const WATCH_QUEUE_MAX_ITEMS = 50;

/**
 * Longest stored title for a queued video.
 *
 * The title is DISPLAY TEXT the adding client supplies (from the in-app search
 * results, or alongside a pasted link) — the gateway has no metadata source of
 * its own, and a queue rendered as 50 opaque 11-character ids is not a queue
 * anyone can use. It is therefore UNTRUSTED: bounded here, stripped of control
 * characters at the boundary, and specified as plain text a client must never
 * render as markup, a link, or anything clickable. Attribution is carried
 * separately by `addedBy`, so a misleading title always traces to a member.
 */
export const WATCH_QUEUE_TITLE_MAX_LENGTH = 120;

// ---------------------------------------------------------------------------
// Watch Party — in-app YouTube SEARCH (M20 wave 2, ADR 0016 revisited)
//
// ADR 0016 deferred search to "post-MVP" because it needs an API key and quota
// management. This is that revisit. The numbers below exist because the quota is
// a HARD external ceiling no amount of our own capacity can raise: YouTube grants
// 10,000 units per project per day and `search.list` costs 100 of them. That is
// ~100 searches PER DAY FOR THE WHOLE DEPLOYMENT — two orders of magnitude
// tighter than any other limit in this codebase, so it gets a real budget rather
// than a per-route rate limit and a hope.
// ---------------------------------------------------------------------------

/** Quota units one `search.list` call costs. Fixed by YouTube, not by us. */
export const YOUTUBE_SEARCH_UNIT_COST = 100;

/**
 * Quota units one `videos.list` call costs, regardless of how many ids are
 * batched into it. This is why durations are fetched for a whole page of results
 * in ONE follow-up call: 15 separate lookups would cost 15 units, one batched
 * lookup costs 1.
 */
export const YOUTUBE_VIDEOS_UNIT_COST = 1;

/**
 * Daily unit budget we allow ourselves, against YouTube's 10,000.
 *
 * The 1,000-unit gap is deliberate headroom for the two ways our accounting can
 * disagree with theirs: our day boundary is approximate (see
 * {@link YOUTUBE_QUOTA_RESET_UTC_OFFSET_HOURS}) and a request we counted may have
 * failed after they charged it. Exhausting the real quota does not degrade
 * gracefully — it fails every search for the rest of the day — so our budget is
 * set to run out BEFORE theirs, while the client can still paste a link.
 */
export const WATCH_SEARCH_DAILY_UNIT_BUDGET = 9_000;

/**
 * Searches one USER may spend against the shared budget per day.
 *
 * At {@link YOUTUBE_SEARCH_UNIT_COST} + {@link YOUTUBE_VIDEOS_UNIT_COST} = 101
 * units per uncached search, 25 searches is ~2,525 units — about a quarter of the
 * daily budget. That is the point: one person picking videos all evening cannot
 * take the whole friend group's day down with them, and four heavy users still
 * leave room for everyone else. Cache hits do NOT count against it (they spend no
 * units), so re-running a query while deciding is free.
 */
export const WATCH_SEARCH_PER_USER_PER_DAY = 25;

/**
 * YouTube resets project quota at midnight Pacific. We approximate that with a
 * fixed -8h offset rather than tracking US daylight saving, so our window can sit
 * up to one hour off theirs for part of the year. That is safe in one direction
 * only — and it is the direction we are in, because
 * {@link WATCH_SEARCH_DAILY_UNIT_BUDGET} is 10% below the real ceiling, so an
 * hour of overlap cannot spend quota we do not have.
 */
export const YOUTUBE_QUOTA_RESET_UTC_OFFSET_HOURS = -8;

/** Longest accepted search query. Bounds the URL we build and the work we ask for. */
export const WATCH_SEARCH_QUERY_MAX_LENGTH = 100;

/**
 * Results returned for one query. Small on purpose: this is a picker inside a
 * voice-channel panel, not a search engine, and every extra row is one more id to
 * validate and one more thumbnail to load.
 */
export const WATCH_SEARCH_MAX_RESULTS = 15;

/**
 * How long an identical query's results are reused. Ten minutes is long enough
 * that the realistic pattern — the same person re-running a query while deciding
 * — costs ONE unit charge, and short enough that a new upload appears the same
 * evening.
 */
export const WATCH_SEARCH_CACHE_TTL_MS = 10 * 60_000;

/**
 * The day bucket quota is counted in, as `YYYY-MM-DD` in YouTube's reset zone
 * (see {@link YOUTUBE_QUOTA_RESET_UTC_OFFSET_HOURS}). A plain string so it can be
 * a Redis key suffix and read straight out of `redis-cli` when someone asks why
 * search stopped working.
 */
export function youtubeQuotaDayKey(nowMs: number): string {
  const shifted = new Date(nowMs + YOUTUBE_QUOTA_RESET_UTC_OFFSET_HOURS * 3_600_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The thumbnail URL for a video, built by US from the id.
 *
 * The search response carries thumbnail URLs of its own and we deliberately do
 * not use them: that string would be an externally-controlled URL rendered as an
 * `<img src>` on every member's machine — exactly the class of trust we refused
 * for `videoRef`. The id has already passed {@link WATCH_VIDEO_ID_PATTERN}, so a
 * URL built from it cannot carry a scheme, a host, a query string or a path
 * traversal; the whole surface disappears.
 *
 * `mqdefault.jpg` (320x180) exists for every video, including ones with no custom
 * thumbnail, so this never renders a broken image.
 */
export function youtubeThumbnailUrl(videoId: string): string | null {
  if (!isYouTubeVideoId(videoId)) return null;
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

/**
 * Parse an ISO-8601 duration (`PT4M13S`, `PT1H2M`, `P1D`) to whole seconds, or
 * null when it is not a duration we can honestly report.
 *
 * YouTube returns durations in this format and nothing else consumes it, so the
 * parser is deliberately narrow: day/hour/minute/second components only, all
 * integers, the total bounded by {@link WATCH_POSITION_MAX_SECONDS} — the same
 * 24 h ceiling a playback position obeys, so a parsed duration can never be a
 * number the rest of the contract would refuse.
 *
 * A total of ZERO is null, not 0. This is not pedantry: a LIVE STREAM answers
 * `P0D`, and a live stream is precisely the case where a confident "0:00" next
 * to a broadcast that has been running for three hours is worse than showing no
 * duration at all. There is no real video of zero length for this to cost.
 */
export function parseIso8601DurationSeconds(value: string): number | null {
  const match = /^P(?:(\d{1,4})D)?(?:T(?:(\d{1,4})H)?(?:(\d{1,4})M)?(?:(\d{1,4})S)?)?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  const total =
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);
  if (!Number.isFinite(total) || total <= 0 || total > WATCH_POSITION_MAX_SECONDS) return null;
  return total;
}

/**
 * Strip control characters and collapse whitespace in externally-sourced display
 * text (a queued video's title, a search result's title/channel name), then bound
 * it. Returns null for anything that reduces to nothing, so an empty string never
 * masquerades as a title.
 *
 * These strings come from YouTube or from another member's client and are
 * rendered as TEXT on everyone's screen. Escaping is the renderer's job; what
 * belongs here is the part a renderer cannot do for itself — refusing embedded
 * newlines, bidi overrides and zero-width characters that would let one row
 * impersonate several, or read as something it is not.
 */
export function sanitizeWatchDisplayText(
  value: string,
  maxLength = WATCH_QUEUE_TITLE_MAX_LENGTH,
): string | null {
  const cleaned = value
    // C0/C1 controls, zero-width characters, and the bidi embedding/override/
    // isolate ranges. `no-control-regex` is disabled deliberately and narrowly:
    // the rule exists to catch control characters that ended up in a pattern by
    // accident, and here they ARE the subject — this is the line that removes
    // them from text other people will read.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, maxLength);
}
