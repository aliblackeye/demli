/**
 * Client-side rendering of server "system" messages (ADR 0009 §5).
 *
 * The API writes a stable, language-neutral token as the message content
 * (`@sys:member_joined`) — never human language and never the display name. The
 * client resolves the current author's `displayName` itself and translates the
 * token here, so every viewer sees the message in their own language and a
 * rename updates all past system messages.
 */

/** Prefix that marks a message content as a system token. */
export const SYSTEM_MESSAGE_PREFIX = "@sys:";

/**
 * Every token the API may emit. Keep in sync with `common.system.*` keys.
 *
 * DM-call tokens (ADR 0012): `call_ended` is emitted parameterized as
 * `@sys:call_ended:<seconds>` (talk time) — the trailing arg is parsed here into
 * a `mm:ss` `{{duration}}`. The rest are bare.
 */
export const SYSTEM_MESSAGE_TOKENS = [
  "member_joined",
  "member_left",
  "call_ended",
  "call_missed",
  "call_declined",
  "call_canceled",
] as const;

export type SystemMessageToken = (typeof SYSTEM_MESSAGE_TOKENS)[number];

/** Full persisted content for a token, e.g. `@sys:member_joined`. */
export function systemMessageContent(token: SystemMessageToken): string {
  return `${SYSTEM_MESSAGE_PREFIX}${token}`;
}

export function isSystemMessageToken(value: string): value is SystemMessageToken {
  return (SYSTEM_MESSAGE_TOKENS as readonly string[]).includes(value);
}

/** Format a talk-time in seconds as `m:ss` (or `h:mm:ss` past an hour). */
export function formatCallDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = sec.toString().padStart(2, "0");
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

/**
 * Minimal translate function accepted by {@link resolveSystemMessage}. Any
 * i18next `t` satisfies it — kept structural so this module never depends on the
 * React binding or i18next's generic `TFunction` type.
 */
export type TranslateFn = (
  key: string,
  options?: { name?: string; duration?: string },
) => string;

/**
 * Render a message's stored `content` for display.
 *
 * - `@sys:<known token>` → translated template with the author's display name
 *   (and, for `call_ended`, the `{{duration}}` parsed from the trailing seconds).
 * - Unknown `@sys:` token OR plain text (legacy Turkish rows written before
 *   tokenization) → returned verbatim. This backward-compat fallback is why no
 *   data migration is needed.
 */
export function resolveSystemMessage(
  content: string,
  displayName: string,
  t: TranslateFn,
): string {
  if (!content.startsWith(SYSTEM_MESSAGE_PREFIX)) return content;
  const raw = content.slice(SYSTEM_MESSAGE_PREFIX.length);
  // `call_ended` carries a trailing `:<seconds>`; every other token is bare.
  const colon = raw.indexOf(":");
  const token = colon === -1 ? raw : raw.slice(0, colon);
  if (!isSystemMessageToken(token)) return content;
  if (token === "call_ended") {
    const seconds = Number(colon === -1 ? NaN : raw.slice(colon + 1));
    const duration = Number.isFinite(seconds) ? formatCallDuration(seconds) : "";
    return t("common:system.call_ended", { name: displayName, duration });
  }
  return t(`common:system.${token}`, { name: displayName });
}
