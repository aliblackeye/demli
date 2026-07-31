/**
 * The one-time "verify your age" reminder must stay gone once dismissed, and it
 * must be per ACCOUNT — this app switches accounts in place (ADR 0013), so a
 * global flag would silently hide the reminder for every account signed into
 * afterwards.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { shouldPromptForBirthdate } from "@demli/client-core";
import type { UserId } from "@demli/types";

// The suite runs in the node env, where zustand's persist middleware has no
// localStorage to write to. Give it an in-memory one so a real dismissal is
// actually persisted here (and the middleware stops warning on every write).
const memory = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
});

const { useAgePromptStore } = await import("./age-prompt-store");

const ALI = "user_ali" as UserId;
const BURAK = "user_burak" as UserId;

const dismissedFor = (id: UserId): boolean =>
  useAgePromptStore.getState().dismissedByUser[id] ?? false;

/** The exact expression the pill evaluates, for a loaded account with no DOB. */
const promptVisibleFor = (id: UserId): boolean =>
  shouldPromptForBirthdate({
    selfLoaded: true,
    birthdateSet: false,
    dismissed: dismissedFor(id),
  });

beforeEach(() => {
  useAgePromptStore.setState({ dismissedByUser: {} });
});

describe("age prompt dismissals", () => {
  it("shows the reminder to an account that has not dismissed it", () => {
    expect(promptVisibleFor(ALI)).toBe(true);
  });

  it("never comes back after a single dismissal", () => {
    useAgePromptStore.getState().dismiss(ALI);
    expect(promptVisibleFor(ALI)).toBe(false);

    // Dismissing again is a no-op, and a re-render still resolves to hidden.
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
