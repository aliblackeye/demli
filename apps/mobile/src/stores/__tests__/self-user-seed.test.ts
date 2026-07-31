/**
 * Regression guard for the founder-reported P0: after switching accounts, the
 * user's OWN messages in a DM rendered as "Bilinmeyen" (unknown author).
 *
 * Root cause: `users` is seeded at sign-in by app/_layout's effect keyed on auth
 * `status`. An account switch deliberately keeps `status` authenticated (ADR
 * 0013), so that effect never re-fires — while the switch's `storeReset` wiped
 * the directory. On a server channel the group-details query happens to re-seed
 * self (it returns the roster, self included); a DM has NO roster query, so
 * `users[meId]` stayed undefined and the row fell back to "unknown author".
 *
 * The contract proven here: `resetChatState(self)` re-seeds the session user in
 * the SAME update as the wipe, so there is not even a one-tick window where the
 * current user is missing from the directory.
 *
 * chat-store transitively imports expo-secure-store (divider watermarks), so we
 * mock it to an inert async backend under vitest's node env.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

import type { ChannelId, User, UserId } from "@demli/types";
import { useChatStore } from "../chat-store";

const OLD_ME = "u-old" as UserId;
const NEW_ME = "u-new" as UserId;
const PEER = "u-peer" as UserId;
const C1 = "c1" as ChannelId;

function user(id: UserId, displayName: string): User {
  return {
    id,
    username: displayName.toLowerCase(),
    displayName,
    avatarUrl: null,
    bio: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/** What a message row would render for `authorId` (ChatThread's resolveName). */
function resolvedName(authorId: UserId): string | null {
  const found = useChatStore.getState().users[authorId];
  return found?.displayName ?? found?.username ?? null;
}

describe("session-user seed in the author directory", () => {
  beforeEach(() => {
    useChatStore.getState().resetChatState();
  });

  it("account switch: the reset re-seeds the NEW user and drops the old identity", () => {
    const chat = useChatStore.getState();
    chat.upsertUsers([user(OLD_ME, "Ali"), user(PEER, "Burak")]);
    expect(resolvedName(OLD_ME)).toBe("Ali");

    // The switch's storeReset effect (lib/account-manager) — the auth store has
    // already pivoted onto the target account at this point.
    useChatStore.getState().resetChatState(user(NEW_ME, "Mert"));

    // The new account resolves IMMEDIATELY: no window where own messages would
    // render as "unknown author" (this is the founder-reported bug).
    expect(resolvedName(NEW_ME)).toBe("Mert");
    // The previous account's directory is gone (no identity bleed across a switch).
    expect(resolvedName(OLD_ME)).toBeNull();
    expect(resolvedName(PEER)).toBeNull();
  });

  it("the re-seed survives a wipe with nothing else re-seeding it (the DM case)", () => {
    // A DM has no roster query to refill `users`, so the reset's seed is the ONLY
    // thing standing between the user and "unknown author" on their own messages.
    useChatStore.getState().resetChatState(user(NEW_ME, "Mert"));
    expect(Object.keys(useChatStore.getState().users)).toEqual([NEW_ME]);
  });

  it("resets every other per-user slice while keeping the seed", () => {
    const chat = useChatStore.getState();
    chat.markChannelUnread(C1);
    chat.setPresence(PEER, "online");
    chat.setTyping(C1, PEER, Date.now() + 5_000);

    useChatStore.getState().resetChatState(user(NEW_ME, "Mert"));

    const state = useChatStore.getState();
    expect(state.unreadChannelIds[C1]).toBeUndefined();
    expect(state.presence[PEER]).toBeUndefined();
    expect(state.typing[C1]).toBeUndefined();
    expect(state.users[NEW_ME]?.displayName).toBe("Mert");
  });

  it("full sign-out (no session user) leaves the directory empty", () => {
    useChatStore.getState().upsertUsers([user(OLD_ME, "Ali")]);
    useChatStore.getState().resetChatState(null);
    expect(useChatStore.getState().users).toEqual({});
  });

  it("a later profile refresh replaces the seeded projection in place", () => {
    useChatStore.getState().resetChatState(user(NEW_ME, "Mert"));
    // account-manager's profileRefresh (switch step 9) upserts the authoritative
    // profile — the display name must follow, not duplicate.
    useChatStore.getState().upsertUsers([{ ...user(NEW_ME, "Mert Y."), avatarUrl: "a.png" }]);
    expect(resolvedName(NEW_ME)).toBe("Mert Y.");
    expect(Object.keys(useChatStore.getState().users)).toEqual([NEW_ME]);
  });
});
