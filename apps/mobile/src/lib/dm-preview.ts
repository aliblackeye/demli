/**
 * Rich DM-row helpers (mobile Home redesign). A DM row shows the last message's
 * content + a compact relative time. The preview shape is an
 * additive field the API attaches to each `/dms` entry; the `Dm` domain type in
 * `@demli/types` is intentionally left untouched (packages stay read-only), so
 * this mobile-local type widens it structurally.
 *
 * System notices (`@sys:*` — e.g. DM-call outcomes) are localized through the
 * shared `resolveSystemMessage`, exactly like the in-thread <SystemMessage>, so a
 * "Call ended · 2:14" preview reads the same in the list as in the conversation.
 */
import { resolveSystemMessage } from "@demli/i18n";
import type { Dm, MessageKind, UserId } from "@demli/types";
import type { AppTFunction } from "./i18n";
import { toTranslateFn } from "./i18n";

/**
 * The last message in a DM, denormalized by the API for the list preview. Carries
 * only what a one-line preview needs — never the full message. `kind` drives the
 * `@sys:*` localization branch; `authorId` drives the "You:" prefix.
 */
export interface LastMessagePreview {
  content: string;
  authorId: UserId;
  kind: MessageKind;
  createdAt: string;
}

/** A `/dms` entry widened with the optional API-attached preview (see above). */
export type DmWithPreview = Dm & { lastMessagePreview?: LastMessagePreview | null };

/** Collapse newlines/runs of whitespace so a multi-line message previews as one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The one-line preview text for a DM's last message:
 *  - system notice → localized via `resolveSystemMessage` (author = the peer).
 *  - my own message → "You: …" so the sender is clear at a glance.
 *  - the peer's message → the text verbatim.
 *  - attachment-only (empty content) → a generic "Attachment" label.
 * Returns null when there is no preview, so the row falls back to `@username`.
 */
export function dmPreviewText(
  preview: LastMessagePreview | null | undefined,
  peerName: string,
  meId: UserId | null,
  t: AppTFunction,
): string | null {
  if (!preview) return null;

  if (preview.kind === "system") {
    return resolveSystemMessage(preview.content, peerName, toTranslateFn(t));
  }

  const text = oneLine(preview.content);
  const body = text.length > 0 ? text : t("mobile:direct.attachmentPreview");
  if (meId && preview.authorId === meId) {
    return `${t("mobile:direct.youPrefix")} ${body}`;
  }
  return body;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact relative timestamp for a DM row ("now", "5m", "3h", "2d", then a short
 * date). Localized suffixes; falls back to a locale date string past a week.
 */
export function dmRelativeTime(iso: string | null | undefined, t: AppTFunction): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  if (diff < MINUTE) return t("mobile:direct.timeNow");
  if (diff < HOUR) return t("mobile:direct.timeMinutes", { count: Math.floor(diff / MINUTE) });
  if (diff < DAY) return t("mobile:direct.timeHours", { count: Math.floor(diff / HOUR) });
  if (diff < 7 * DAY) return t("mobile:direct.timeDays", { count: Math.floor(diff / DAY) });
  return new Date(then).toLocaleDateString([], { month: "short", day: "numeric" });
}
