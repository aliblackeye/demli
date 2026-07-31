/**
 * Source-level invariants for the user context menu's WIRING.
 *
 * The behaviour itself is covered by real DOM tests in @demli/app-ui
 * (ActionMenu.profile.test.tsx, MessageComposer.mention.test.tsx). What those
 * cannot see is the desktop menu quietly going back to the shape that broke:
 *
 *  - "Profile" and "Mention" opening their surface INLINE from `onSelect`. That
 *    reads perfectly and is exactly the bug — an open Radix menu traps focus, so
 *    the card it opens is dismissed in the same tick. The founder's report was
 *    "profil basınca çalışmadı", with nothing in the console.
 *  - the menu learning a note's CONTENT rather than just whether one exists. It
 *    needs a boolean to say "Add note" vs "Edit note"; rendering the body in a
 *    menu row would put a private note on screen next to the person it is about
 *    (ADR 0019 §1).
 *
 * Both are one-line regressions with no visible failure, which is precisely the
 * kind this repo pins with a source assertion rather than hoping a reviewer
 * notices.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RENDERER_SRC = fileURLToPath(new URL("..", import.meta.url));

function read(relative: string): string {
  return readFileSync(join(RENDERER_SRC, relative), "utf8");
}

const MENU = read("components/MemberContextMenu.tsx");
const CARD = read("components/ProfileCard.tsx");
const DIALOGS = read("components/MemberDialogs.tsx");

describe("user menu wiring", () => {
  it("opens the profile card AFTER the menu closes, never inline", () => {
    expect(MENU).toMatch(/afterClose\(\(\)\s*=>\s*openProfileFrom\(/);
    // The only call site is the deferred one.
    expect(MENU.match(/openProfileFrom\(/g)?.length).toBe(2); // the call + its definition
  });

  it("inserts a mention AFTER the menu closes, so the composer keeps focus", () => {
    expect(MENU).toMatch(/afterClose\(\(\)\s*=>\s*requestMentionInsert\(/);
  });

  it("captures the trigger node before deferring (the ref is cleared on teardown)", () => {
    expect(MENU).toMatch(/const trigger = triggerRef\?\.current \?\? null;/);
  });

  it("decides Add-vs-Edit from the SHARED rule, not a local ternary", () => {
    expect(MENU).toContain("memberMenuEntryVariant");
    for (const key of ["userMenu.noteEdit", "userMenu.friendNicknameEdit", "userMenu.serverNicknameEdit"]) {
      expect(MENU).toContain(key);
    }
  });
});

describe("private note stays a boolean in the menu", () => {
  it("reads only whether a note exists", () => {
    expect(MENU).toContain("hasNote: Boolean(note?.body)");
  });

  it("never renders the note body in a menu row", () => {
    // A menu row is anchored to the roster/message the user right-clicked, i.e.
    // to the person the note is ABOUT — the one surface it must never appear on.
    expect(MENU).not.toMatch(/\{\s*note[?.]*\.body\s*\}/);
  });

  it("is fetched only for someone ELSE (you cannot note yourself)", () => {
    expect(MENU).toContain("useUserNote(target.userId, !isSelf)");
    expect(CARD).toContain("useUserNote(userId, !isSelf)");
  });
});

describe("profile card note badge", () => {
  it("renders the note through the shared shortener, never raw beside the name", () => {
    expect(CARD).toContain("noteBadgeText(note?.body)");
    expect(CARD).toMatch(/isSelf \? null : noteBadgeText/);
  });
});

describe("optional values can be removed", () => {
  it("offers an explicit Remove in all three editors", () => {
    expect(DIALOGS.match(/<RemoveValueButton/g)?.length).toBe(3);
  });

  it("gates Remove on the SAVED value, not on what is currently typed", () => {
    // Gating on the input is what hid it: clearing the field to delete made the
    // delete button disappear.
    expect(DIALOGS).toContain("hasSavedNote ? (");
    expect(DIALOGS).toContain("dialog.current !== null ? (");
    expect(DIALOGS).not.toMatch(/value\.trim\(\)\.length > 0 \? \(\s*<RemoveValueButton/);
  });

  it("sends null to clear, which is what the API treats as a delete", () => {
    expect(DIALOGS).toMatch(/onRemove=\{\(\) => save\(null\)\}/);
  });
});
