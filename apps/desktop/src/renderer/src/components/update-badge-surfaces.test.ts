/**
 * EVERY centre surface renders the update badge.
 *
 * The badge is not one component in the shell — each surface puts it in its own
 * header action group, so it sits with the controls that already live there
 * instead of floating over them. The cost of that choice is that a new surface
 * can simply forget it, and the failure is invisible: the app updates fine, the
 * badge just never appears while the user is on that screen.
 *
 * That is exactly what happened. `VideoStage` — the voice room, which is where
 * this product is actually used — was missed, so a user sitting in a call with
 * their camera on saw no update badge at all (founder, 2026-07-28: "güncelleme
 * gelmiş ama üstte yeşil indirme butonu çıkmadığı oluyor. güncellemeyi
 * kaçırmasın"). Nothing errored; the badge was simply somewhere else.
 *
 * This test is the guard rail for that whole class: add a centre surface, add it
 * here, and the omission fails the build instead of shipping. Source-level
 * because mounting five surfaces (each with its own data + media graph) to assert
 * one glyph would be far more machinery than the thing it protects — the same
 * reasoning as `user-menu-wiring.test.ts`.
 *
 * If a surface ever genuinely should NOT carry the badge, move it to
 * `EXEMPT` with the reason written down, rather than deleting the assertion.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Every component that can own the centre column. */
const CENTRE_SURFACES = [
  "ChatView.tsx",
  "DmView.tsx",
  "GroupChatView.tsx",
  "FriendsView.tsx",
  "RecentCallsView.tsx",
  "VideoStage.tsx",
] as const;

/**
 * Surfaces deliberately without the badge, and why.
 *
 * `EmbeddedCallStage` renders INSIDE a DM conversation, whose own header already
 * carries the badge — a second one would be a duplicate in the same view.
 * `WatchPartyStage` is a tile within `VideoStage`, not a centre surface itself.
 */
const EXEMPT: Record<string, string> = {
  "EmbeddedCallStage.tsx": "nested in DmView, which already renders the badge",
  "WatchPartyStage.tsx": "a tile inside VideoStage, not a centre surface",
};

function sourceOf(file: string): string {
  return readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");
}

describe("update badge is reachable from every centre surface", () => {
  it.each(CENTRE_SURFACES)("%s renders <UpdateBadge />", (file) => {
    expect(sourceOf(file)).toContain("<UpdateBadge");
  });

  it("documents the surfaces that intentionally skip it", () => {
    // Not a formality: it forces a reason to exist for each omission, so "it was
    // forgotten" and "it was decided" stop looking the same in the codebase.
    for (const [file, reason] of Object.entries(EXEMPT)) {
      expect(reason.length).toBeGreaterThan(10);
      expect(sourceOf(file)).not.toContain("<UpdateBadge");
    }
  });
});
