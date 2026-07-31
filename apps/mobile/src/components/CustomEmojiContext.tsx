import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { GroupId } from "@demli/types";
import { useCustomEmojiMap } from "../queries/chat-queries";

/**
 * Group-scoped custom-emoji context for a chat screen (M17) — the mobile twin of
 * the desktop renderer's components/CustomEmojiContext.tsx.
 *
 * Why a context and not a hook inside MessageMarkdown (§27): the `:name:` → URL
 * map is the SAME for every row of a channel and the list keeps many rows
 * mounted. A per-row `useCustomEmojiMap()` would mean one query subscription per
 * row re-running on every emoji cache tick; one provider at the screen level
 * means exactly one, and the rows read a stable `ReadonlyMap` through context.
 *
 * `groupId` rides along so the composer's picker knows which group's emoji it may
 * offer. Surfaces WITHOUT a server context (a 1:1 DM, a flat group chat) get
 * null and simply have no custom emoji: every shortcode renders as literal
 * `:name:` text, the same graceful fallback a deleted emoji gets.
 */
export interface CustomEmojiContextValue {
  groupId: GroupId | null;
  byName: ReadonlyMap<string, string>;
}

const EMPTY_VALUE: CustomEmojiContextValue = { groupId: null, byName: new Map() };

const CustomEmojiContext = createContext<CustomEmojiContextValue>(EMPTY_VALUE);

/** Mount ONCE per chat screen — never per message row. */
export function CustomEmojiProvider({
  groupId,
  children,
}: {
  groupId: GroupId | null;
  children: ReactNode;
}): JSX.Element {
  const byName = useCustomEmojiMap(groupId);
  const value = useMemo<CustomEmojiContextValue>(
    () => (groupId ? { groupId, byName } : EMPTY_VALUE),
    [groupId, byName],
  );
  return <CustomEmojiContext.Provider value={value}>{children}</CustomEmojiContext.Provider>;
}

/** The screen's emoji context (empty outside a provider). */
export function useCustomEmojiContext(): CustomEmojiContextValue {
  return useContext(CustomEmojiContext);
}

/** The screen's `:name:` → URL map (empty outside a provider). */
export function useCustomEmojiUrlMap(): ReadonlyMap<string, string> {
  return useContext(CustomEmojiContext).byName;
}
