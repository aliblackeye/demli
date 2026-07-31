import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { GroupId } from "@demli/types";
import { useCustomEmojiMap } from "../queries/chat-queries";

/**
 * Group-scoped custom-emoji context for a chat surface (M17).
 *
 * Why a context and not a hook inside MessageMarkdown (§27): the `:name:` → URL
 * map is the SAME for every row of a channel, and a virtualized list keeps ~50
 * rows mounted. A per-row `useCustomEmojiMap()` would mean 50 query
 * subscriptions re-running on every emoji cache tick; one provider at the
 * surface level means exactly one, and the rows read a stable `ReadonlyMap`
 * reference through `useContext`.
 *
 * `groupId` rides along so the composer's picker knows which group's emoji it may
 * offer without re-deriving it — and so surfaces WITHOUT a server context (a 1:1
 * DM, a flat group chat) get null and simply have no custom emoji: every
 * shortcode renders as literal `:name:` text, the same graceful fallback a
 * deleted emoji gets.
 */
export interface CustomEmojiContextValue {
  /** The server whose emoji resolve here, or null outside a server surface. */
  groupId: GroupId | null;
  /** `:name:` → signed image URL. Empty outside a provider. */
  byName: ReadonlyMap<string, string>;
}

const EMPTY_VALUE: CustomEmojiContextValue = { groupId: null, byName: new Map() };

const CustomEmojiContext = createContext<CustomEmojiContextValue>(EMPTY_VALUE);

/**
 * Provide the active server's emoji to everything below. Mount ONCE per chat
 * surface (the server ChatView) — never per message row.
 */
export function CustomEmojiProvider({
  groupId,
  children,
}: {
  groupId: GroupId | null;
  children: ReactNode;
}): JSX.Element {
  const byName = useCustomEmojiMap(groupId);
  // `useCustomEmojiMap` already memoizes on its two caches, so this only changes
  // when the emoji set or its signed URLs actually change.
  const value = useMemo<CustomEmojiContextValue>(
    () => (groupId ? { groupId, byName } : EMPTY_VALUE),
    [groupId, byName],
  );
  return <CustomEmojiContext.Provider value={value}>{children}</CustomEmojiContext.Provider>;
}

/** The surface's emoji context (empty outside a provider). */
export function useCustomEmojiContext(): CustomEmojiContextValue {
  return useContext(CustomEmojiContext);
}

/** The surface's `:name:` → URL map (empty outside a provider). */
export function useCustomEmojiUrlMap(): ReadonlyMap<string, string> {
  return useContext(CustomEmojiContext).byName;
}
