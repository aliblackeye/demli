import { CountPill } from "../ui/Badge";

/**
 * The small numeric unread badge (#110) shared by every Home surface — DM/channel
 * rows, the server rail avatar, the group list. A pill that hugs its text: a
 * 20px circle for one digit, widening for "12" / "99+" / "1+". The text is
 * produced upstream by `unreadBadgeText` (the "no fake number" rule lives there);
 * this component is presentation only, drawn by the kit's {@link CountPill}.
 *
 * Two tones, one meaning each (the desktop rule): `accent` (Demli coral, the
 * default) means "spoken to" — a mention, or a DM; `neutral` (a white chip with
 * dark ink) is a plain unread — the rail tile's and a channel row's (see
 * home-list-rules `channelRowBadge`), so a mention still reads as stronger. Both fills are LIGHT, so both
 * take dark ink — white on the coral reads at ~2.4:1.
 */
export function UnreadCountBadge({
  text,
  tone = "accent",
  a11yLabel,
}: {
  text: string;
  tone?: "accent" | "neutral";
  a11yLabel?: string;
}) {
  return <CountPill text={text} tone={tone} label={a11yLabel} />;
}
