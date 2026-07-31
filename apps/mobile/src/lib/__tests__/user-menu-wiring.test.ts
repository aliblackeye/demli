/**
 * Source-level invariants for the mobile user menu, the composer's mention
 * insert, and the profile screen's note badge — the mobile twin of the desktop
 * `user-menu-wiring.test.ts`.
 *
 * There is no React Native render harness in this package (vitest runs
 * node-only, "pure logic" by policy), and the behaviour these files depend on is
 * already proven where it lives: `applyMentionInsert`, `memberMenuEntryVariant`
 * and `noteBadgeText` all have real behavioural tests in @demli/client-core.
 * What no test elsewhere can see is a RENDERER quietly going back to the shape
 * that broke — and every regression pinned below was a silent one:
 *
 *  - the composer splicing a mention at a bare caret, which produces `selam@Ali`
 *    and ships it as PLAIN TEXT (serializeMentions refuses an `@` glued to a
 *    word, deliberately, so `mail@host` is never a ping). The user believes they
 *    tagged someone; nobody is tagged, and nothing looks wrong.
 *  - the menu saying "Add note" over a note that already exists, so you cannot
 *    tell whether you are about to create or overwrite.
 *  - the note/nickname editors offering no way to REMOVE a value (the founder's
 *    report: "takma adı ekleyince silme yok, notta da aynı şekilde").
 *  - the note's BODY reaching a surface it must not: a menu row anchored to the
 *    person it is about, or the viewer's own profile card (ADR 0019 §1).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `fileURLToPath(import.meta.url)` rather than `new URL(…, import.meta.url)`:
// this package's tsconfig carries the DOM lib, so the global `URL` is not the
// node one `fileURLToPath` expects and the URL form does not typecheck.
const HERE = fileURLToPath(import.meta.url); // …/src/lib/__tests__/<this file>
const MOBILE_SRC = join(HERE, "..", "..", ".."); // …/src
const MOBILE_ROOT = join(MOBILE_SRC, ".."); // apps/mobile

function read(relative: string): string {
  return readFileSync(join(MOBILE_SRC, relative), "utf8");
}

const COMPOSER = read("components/Composer.tsx");
const SHEET = read("components/member/MemberActionSheet.tsx");
const FORM = read("components/member/MemberTextSheet.tsx");
const PROFILE = readFileSync(join(MOBILE_ROOT, "app/(app)/user/[userId].tsx"), "utf8");

describe("composer mention insert", () => {
  it("goes through the SHARED applyMentionInsert, not a caret splice", () => {
    expect(COMPOSER).toContain("applyMentionInsert(prev, caret, { id: userId, label })");
  });

  it("never reaches for applyMentionPick from the menu path", () => {
    // applyMentionPick is still correct for the AUTOCOMPLETE (it replaces a real
    // `@query` fragment). It is only wrong when there is no fragment — which is
    // exactly the menu path, where fragmentStart === caret.
    expect(COMPOSER).not.toMatch(/applyMentionPick\(\s*prev\s*,\s*caret\s*,\s*caret\s*,/);
    expect(COMPOSER).toContain("applyMentionPick(text, mentionQuery.start, selection.end, candidate)");
  });
});

describe("Add vs Edit comes from the shared rule", () => {
  it("uses memberMenuEntryVariant rather than a local ternary per row", () => {
    expect(SHEET).toContain("memberMenuEntryVariant");
    expect(SHEET).toMatch(/const variantOf = /);
  });

  it("renders the Edit copy for all three editable entries", () => {
    for (const key of [
      "userMenu.noteEdit",
      "userMenu.friendNicknameEdit",
      "userMenu.serverNicknameEdit",
    ]) {
      expect(SHEET).toContain(key);
    }
  });

  it("feeds the rule from EXISTENCE, never from the note's content", () => {
    expect(SHEET).toContain("hasNote: Boolean(noteQuery.data?.body)");
  });
});

describe("a value that can be set can be removed", () => {
  it("offers an explicit Remove on the note editor", () => {
    expect(SHEET).toContain('clearLabel={t("mobile:userMenu.noteRemove")}');
  });

  it("offers one on both nickname editors", () => {
    expect(SHEET.match(/clearLabel=\{t\("mobile:userMenu\.nicknameReset"\)\}/g)?.length).toBe(2);
  });

  it("the Remove button sends null — the API's 'clear it' signal", () => {
    expect(FORM).toContain("onPress={() => onSave(null)}");
  });

  it("shows Remove only when there IS a stored value, gated on the SAVED one", () => {
    // Gated on `initialValue`, not on the text box: a user who has cleared the
    // field to delete must still see the button that does it.
    expect(FORM).toContain('const hasStoredValue = (initialValue ?? "").trim().length > 0;');
    expect(FORM).toContain("{clearLabel && hasStoredValue ? (");
  });
});

describe("a private note stays private", () => {
  it("the menu never renders the note body in a row", () => {
    // A menu row is anchored to the person the note is ABOUT — the one surface
    // it must never appear on.
    expect(SHEET).not.toMatch(/\{\s*noteQuery\.data\?\.body\s*\}/);
  });

  it("the profile screen never fetches a note for your OWN card", () => {
    expect(PROFILE).toContain("useUserNote(noteUserId, !isSelf)");
  });

  it("the profile badge is short-circuited on isSelf before it is even shaped", () => {
    // Belt and braces with the query gate above: a stale cache entry must not be
    // able to render your own note back at you.
    expect(PROFILE).toContain("const noteBadge = isSelf ? null : noteBadgeText(note.data?.body);");
  });

  it("the badge uses the SHARED shortener, not an ad-hoc slice", () => {
    expect(PROFILE).toContain("noteBadgeText");
    expect(PROFILE).not.toMatch(/note\.data\?\.body\?\.slice\(/);
  });
});

describe("the copy row hands over the USERNAME", () => {
  it("never puts the internal user id on the clipboard", () => {
    // Founder: "kullanıcı idsini kopyalayınca database id değil, username'ini
    // vermeliydi". The storage uuid is useless to a person — you cannot add a
    // friend, search, or introduce yourself with it.
    expect(SHEET).not.toContain("Clipboard.setStringAsync(target.userId)");
  });

  it("copies the resolved handle instead", () => {
    expect(SHEET).toContain("const handle = nameParts.username ?? null;");
    expect(SHEET).toContain("Clipboard.setStringAsync(handle)");
    expect(SHEET).toContain('t("mobile:userMenu.copyUsername")');
  });

  it("renders nothing rather than copying a fallback when the handle is unknown", () => {
    expect(SHEET).toContain("if (!handle) return null;");
  });
});

describe("Profile opens for real", () => {
  it("closes the sheet BEFORE navigating, so the pushed screen is not covered", () => {
    // `run()` is the sheet's close-then-act helper. The desktop twin of this bug
    // was a Radix focus trap; RN has no focus trap, but a Modal left mounted over
    // a freshly pushed screen is the same class of "nothing happened" report.
    expect(SHEET).toMatch(/const run = \(action: \(\) => void\): void => \{\s*\n\s*onClose\(\);/);
    expect(SHEET).toMatch(/case "profile":[\s\S]{0,400}?onPress=\{\(\) =>\s*\n?\s*run\(\(\) =>/);
  });

  it("routes to the profile screen with the resolved name, not a raw id", () => {
    expect(SHEET).toMatch(/pathname: "\/user\/\[userId\]"/);
  });
});
