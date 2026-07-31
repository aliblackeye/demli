/**
 * Which channel categories are collapsed, per server — the mobile twin of the
 * desktop's `useCollapsedCategories` (M18).
 *
 * Purely a VIEW preference: nothing on the server cares, and it deliberately does
 * NOT sync across devices. A phone and a desktop are used in different postures,
 * so collapsing a category on one is not a statement about the other. That is the
 * same call the desktop made when it put this in localStorage rather than in the
 * account.
 *
 * Persistence uses the app's established seam — zustand `persist` over
 * `expo-secure-store` (media-settings / home-shell). Reusing SecureStore adds NO
 * native module, so this ships to the installed APK over the air; an
 * AsyncStorage/MMKV dependency would have changed `runtimeVersion` and forced a
 * new build for what is a remembered chevron.
 *
 * Keyed BY SERVER so one server's collapsed sections never leak into another's,
 * matching the desktop's per-group storage key. SecureStore values are
 * size-limited on Android, so the map is pruned to {@link MAX_TRACKED_SERVERS}
 * servers — the same defensive cap `unread-storage.ts` applies for the same
 * reason. Losing the collapse state of a server you have not opened in a long
 * time is invisible; a write that silently fails is not.
 *
 * Hydration is async, so on a cold start every category renders EXPANDED for one
 * frame and then settles. Expanded-first is the deliberate direction: a category
 * that flashes open is a cosmetic blip, whereas flashing closed would hide the
 * channel the user is heading for.
 *
 * The pure helpers are the tested layer (RN rendering is not simulated here —
 * vitest, node env).
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { secureStorage } from "../lib/secure-storage";

/** Servers whose collapse state is remembered, most-recently-touched first. */
export const MAX_TRACKED_SERVERS = 40;

/** `groupId -> collapsed category ids`. Absent server = nothing collapsed. */
export type CollapsedByServer = Record<string, string[]>;

/**
 * Coerce an untrusted persisted blob into a valid map: drop non-array values,
 * non-string ids and empty entries, and cap the number of tracked servers.
 *
 * Pure, and called by both the persist `merge` and the tests — a corrupted or
 * legacy blob must degrade to "nothing collapsed" rather than throwing on the
 * first render of the channel list.
 */
export function normalizeCollapsedMap(value: unknown): CollapsedByServer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const out: CollapsedByServer = {};
  let kept = 0;
  for (const [groupId, ids] of Object.entries(value as Record<string, unknown>)) {
    if (kept >= MAX_TRACKED_SERVERS) break;
    if (typeof groupId !== "string" || groupId.length === 0) continue;
    if (!Array.isArray(ids)) continue;
    const categoryIds = [
      ...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0)),
    ];
    // An empty list is the default state; storing it wastes the budget.
    if (categoryIds.length === 0) continue;
    out[groupId] = categoryIds;
    kept += 1;
  }
  return out;
}

/** Toggle one category inside one server's list, returning a NEW map. */
export function toggleCollapsed(
  map: CollapsedByServer,
  groupId: string,
  categoryId: string,
): CollapsedByServer {
  const current = map[groupId] ?? [];
  const next = current.includes(categoryId)
    ? current.filter((id) => id !== categoryId)
    : [...current, categoryId];

  const out = { ...map };
  if (next.length === 0) delete out[groupId];
  else out[groupId] = next;
  return normalizeCollapsedMap(out);
}

interface CollapsedCategoriesState {
  /** `groupId -> collapsed category ids`. */
  collapsed: CollapsedByServer;
  /** Flip one category's collapsed state within one server. */
  toggle: (groupId: string, categoryId: string) => void;
  /** Whether this category is collapsed in this server. */
  isCollapsed: (groupId: string, categoryId: string) => boolean;
}

export const useCollapsedCategoriesStore = create<CollapsedCategoriesState>()(
  persist(
    (set, get) => ({
      collapsed: {},
      toggle: (groupId, categoryId) =>
        set((state) => ({ collapsed: toggleCollapsed(state.collapsed, groupId, categoryId) })),
      isCollapsed: (groupId, categoryId) =>
        (get().collapsed[groupId] ?? []).includes(categoryId),
    }),
    {
      name: "demli.collapsed-categories",
      storage: createJSONStorage(() => secureStorage),
      partialize: (s) => ({ collapsed: s.collapsed }),
      // Never trust storage blindly — coerce a legacy/garbage blob to a valid map.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<CollapsedCategoriesState>;
        return { ...current, collapsed: normalizeCollapsedMap(p.collapsed) };
      },
    },
  ),
);

/**
 * Subscribe to ONE server's collapsed set as a plain array.
 *
 * Selecting the server's slice rather than the whole map keeps a collapse in
 * server A from re-rendering server B's list, and keeps the channel list off the
 * re-render path of every unrelated write (§27).
 */
export function useCollapsedCategoryIds(groupId: string | null): string[] {
  return useCollapsedCategoriesStore((s) => (groupId ? (s.collapsed[groupId] ?? EMPTY) : EMPTY));
}

/** Stable identity so the selector above never reports a spurious change. */
const EMPTY: string[] = [];
