import { Smartphone } from "lucide-react";
import type { PresencePlatform, PresenceStatus } from "@demli/types";
import { cn } from "../lib/cn";

const DOT_CLASS: Record<PresenceStatus, string> = {
  online: "bg-online",
  idle: "bg-idle",
  dnd: "bg-dnd",
  // Offline (and the owner-only "invisible", which is the OWNER's view of "appear
  // offline") render a SOLID muted dot, not a hollow ring — a see-through center
  // let the avatar bleed through and read as "no status" (founder: "çevrimdışının
  // rengi yok, içi saydam kalmış"). A filled `bg-offline` sits opaque on the
  // avatar like the other three states. Peers never receive "invisible"; the
  // gateway masks it to offline, so the two look identical by design.
  invisible: "bg-offline",
  offline: "bg-offline",
};

/** Phone-glyph color for the mobile indicator (offline never shows a phone). */
const PHONE_CLASS: Record<Exclude<PresenceStatus, "offline">, string> = {
  online: "text-online",
  idle: "text-idle",
  dnd: "text-dnd",
  invisible: "text-offline",
};

const LABEL: Record<PresenceStatus, string> = {
  online: "Online",
  idle: "Idle",
  dnd: "Do Not Disturb",
  invisible: "Invisible",
  offline: "Offline",
};

/** Default a11y label; mobile online/idle get a phone-aware variant. */
const MOBILE_LABEL: Record<Exclude<PresenceStatus, "offline">, string> = {
  online: "Online on mobile",
  idle: "Idle on mobile",
  dnd: "Do Not Disturb on mobile",
  invisible: "Invisible on mobile",
};

export interface PresenceBadgeProps {
  status: PresenceStatus;
  /**
   * The client kind the user is connected from (task #47). When "mobile" AND the
   * user is online/idle, the badge renders a green/amber phone glyph instead of a
   * plain dot — the founder's "connected from mobile and looking at the app"
   * signal. Any other combination (desktop, unknown, or offline) keeps the dot.
   */
  platform?: PresencePlatform;
  /** Override the a11y label (e.g. a translated string). */
  label?: string;
  /** Override the cut-out ring color to match the surface behind the badge. */
  className?: string;
}

export function PresenceBadge({
  status,
  platform,
  label,
  className,
}: PresenceBadgeProps): JSX.Element {
  // Mobile + connected (online/idle) → phone indicator. Offline stays a dot: an
  // offline user is not "on mobile", and a desktop presence is a plain dot too.
  const showPhone = platform === "mobile" && status !== "offline";

  if (showPhone) {
    return (
      <span
        role="img"
        aria-label={label ?? MOBILE_LABEL[status]}
        className={cn(
          "flex items-center justify-center rounded-[3px] bg-sidebar ring-[2px] ring-sidebar",
          className,
        )}
      >
        <Smartphone aria-hidden className={cn("size-3", PHONE_CLASS[status])} strokeWidth={2.75} />
      </span>
    );
  }

  return (
    <span
      role="img"
      aria-label={label ?? LABEL[status]}
      className={cn(
        "relative block size-[10px] rounded-full ring-[2.5px] ring-sidebar",
        DOT_CLASS[status],
        className,
      )}
    >
      {/* Do Not Disturb: a white dash centered on the red dot. */}
      {status === "dnd" && (
        <span
          aria-hidden
          className="absolute left-1/2 top-1/2 h-[2px] w-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white"
        />
      )}
    </span>
  );
}
