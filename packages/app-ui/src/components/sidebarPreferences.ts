/**
 * The channel sidebar's PERSONAL view preferences, per account+server.
 *
 * Two of them now, and they share a storage shape because they share a nature:
 * neither is anything the server has an opinion about, so both live client-side
 * in localStorage keyed by group id, mirroring how {@link useServerFolders}
 * persists the rail layout.
 *
 *   {@link useCollapsedSections} — which sections are collapsed. Was
 *     `useCollapsedCategories`, category-only; the founder asked for the same
 *     chevron on "Metin Kanalları" / "Ses Kanalları", and giving those two their
 *     own parallel storage would have meant two hooks, two keys and two chances
 *     to disagree about what "collapsed" persists as. So a section key is either
 *     a `CategoryId` or one of {@link SIDEBAR_SECTION_KEYS}, and there is one set.
 *
 *   {@link useHideMutedChannels} — the empty-area menu's "Sust. Kanalları Gizle"
 *     toggle.
 *
 * Storage failures (quota, privacy mode, a non-browser host) degrade to the
 * default rather than throwing — a sidebar that cannot remember a collapse is
 * fine; one that crashes is not.
 *
 * NB the collapse storage key still says `collapsed-categories`. That is
 * deliberate: bumping it to a prettier name would silently expand every category
 * every existing user has collapsed, for no benefit beyond tidiness. The two
 * reserved section keys cannot collide with a real category id (server-issued
 * UUIDs contain no colon), so the old payloads stay valid as-is.
 */
import { useCallback, useEffect, useState } from "react";
import type { CategoryId, GroupId } from "@demli/types";

/** A collapsible sidebar section: a category, or one of the fixed lists. */
export type SidebarSectionKey = CategoryId | string;

/**
 * The two sections that are not categories: the uncategorized Text and Voice
 * lists every server has had since before categories existed.
 */
export const SIDEBAR_SECTION_KEYS = {
  text: "section:text",
  voice: "section:voice",
} as const;

const COLLAPSED_PREFIX = "demli:collapsed-categories:v1:";
const HIDE_MUTED_PREFIX = "demli:hide-muted-channels:v1:";

function scopedKey(prefix: string, groupId: GroupId | null): string {
  return `${prefix}${groupId ?? "none"}`;
}

function readStorage(key: string): string | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(key, value);
  } catch {
    // Quota / privacy mode — the preference simply won't survive a reload.
  }
}

function loadSet(key: string): Set<SidebarSectionKey> {
  const raw = readStorage(key);
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

export interface UseCollapsedSections {
  isCollapsed: (section: SidebarSectionKey) => boolean;
  toggle: (section: SidebarSectionKey) => void;
}

export function useCollapsedSections(groupId: GroupId | null): UseCollapsedSections {
  const key = scopedKey(COLLAPSED_PREFIX, groupId);
  const [collapsed, setCollapsed] = useState<Set<SidebarSectionKey>>(() => loadSet(key));

  // Re-read when the active server changes, so one server's collapsed sections
  // never leak into another's.
  useEffect(() => {
    setCollapsed(loadSet(key));
  }, [key]);

  const toggle = useCallback(
    (section: SidebarSectionKey) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(section)) next.delete(section);
        else next.add(section);
        writeStorage(key, JSON.stringify([...next]));
        return next;
      });
    },
    [key],
  );

  const isCollapsed = useCallback(
    (section: SidebarSectionKey) => collapsed.has(section),
    [collapsed],
  );

  return { isCollapsed, toggle };
}

export interface UseHideMutedChannels {
  hideMuted: boolean;
  toggleHideMuted: () => void;
}

/**
 * "Hide muted channels", per server. Defaults to OFF — a preference that hides
 * rows must be something the user turned on deliberately, never a surprise on
 * first launch.
 */
export function useHideMutedChannels(groupId: GroupId | null): UseHideMutedChannels {
  const key = scopedKey(HIDE_MUTED_PREFIX, groupId);
  const [hideMuted, setHideMuted] = useState<boolean>(() => readStorage(key) === "1");

  useEffect(() => {
    setHideMuted(readStorage(key) === "1");
  }, [key]);

  const toggleHideMuted = useCallback(() => {
    setHideMuted((prev) => {
      const next = !prev;
      writeStorage(key, next ? "1" : "0");
      return next;
    });
  }, [key]);

  return { hideMuted, toggleHideMuted };
}
