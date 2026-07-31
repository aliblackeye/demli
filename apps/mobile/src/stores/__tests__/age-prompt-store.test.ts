/**
 * The one-time "verify your age" reminder must stay gone once dismissed, and it
 * must be per ACCOUNT — the app switches accounts in place (ADR 0013), so a
 * global flag would silently hide the reminder for every account signed into
 * afterwards. Mobile mirror of the desktop store test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The store's only native dependency is expo-secure-store (the persist seam).
// Replace it wholesale so this pure-logic test runs in the node env.
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

import { shouldPromptForBirthdate } from "@demli/client-core";
import type { UserId } from "@demli/types";
import { useAgePromptStore } from "../age-prompt-store";

const ALI = "user_ali" as UserId;
const BURAK = "user_burak" as UserId;

const dismissedFor = (id: UserId): boolean =>
  !!useAgePromptStore.getState().dismissedByUser[id];

/** The exact expression the banner evaluates, for a loaded account with no DOB. */
const promptVisibleFor = (id: UserId): boolean =>
  shouldPromptForBirthdate({
    selfLoaded: true,
    birthdateSet: false,
    dismissed: dismissedFor(id),
  });

beforeEach(() => {
  useAgePromptStore.setState({ dismissedByUser: {} });
});

describe("mobile age prompt dismissals", () => {
  it("shows the reminder to an account that has not dismissed it", () => {
    expect(promptVisibleFor(ALI)).toBe(true);
  });

  it("never comes back after a single dismissal", () => {
    useAgePromptStore.getState().dismiss(ALI);
    expect(promptVisibleFor(ALI)).toBe(false);

    useAgePromptStore.getState().dismiss(ALI);
    expect(promptVisibleFor(ALI)).toBe(false);
  });

  it("keeps each account's dismissal to itself", () => {
    useAgePromptStore.getState().dismiss(ALI);
    expect(promptVisibleFor(ALI)).toBe(false);
    expect(promptVisibleFor(BURAK)).toBe(true);
  });

  it("stops asking an account that HAS a date of birth, dismissed or not", () => {
    expect(
      shouldPromptForBirthdate({ selfLoaded: true, birthdateSet: true, dismissed: false }),
    ).toBe(false);
  });
});
