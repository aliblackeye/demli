/**
 * "One flow per destructive action" — a source-level invariant.
 *
 * Unfriend and block are each reachable from two places: a row in the user
 * context menu, and a small icon on the profile card's banner. The founder rule
 * is that the icon must not be a second implementation — same confirmation, same
 * wording, same mutation. The failure mode is silent and easy: an icon wired
 * straight to `useUnfriend()` fires instantly while the menu row asks first, and
 * nobody notices until someone loses a friendship to a misclick.
 *
 * Both entry points must therefore go through the shared `ui-store` dialog slots
 * (`setBlockDialog` / `setMemberDialog`), and the mutation hooks must be called
 * ONLY inside the dialog components that own those confirmations.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const COMPONENTS = fileURLToPath(new URL("../components/", import.meta.url));

const read = (file: string): string => readFileSync(join(COMPONENTS, file), "utf8");

describe("destructive user actions have exactly one flow", () => {
  const menu = read("MemberContextMenu.tsx");
  const card = read("ProfileCard.tsx");
  const dialogs = read("MemberDialogs.tsx");

  it("the menu confirms unfriending instead of mutating inline", () => {
    expect(menu).toMatch(/setMemberDialog\(\{\s*kind:\s*"unfriend"/);
    expect(menu).not.toMatch(/useUnfriend\(/);
  });

  it("the profile card's banner icon opens the SAME unfriend confirmation", () => {
    expect(card).toMatch(/setMemberDialog\(\{\s*kind:\s*"unfriend"/);
    expect(card).not.toMatch(/useUnfriend\(/);
  });

  it("both entry points confirm a block through the shared dialog", () => {
    expect(menu).toMatch(/setBlockDialog\(/);
    expect(card).toMatch(/setBlockDialog\(/);
    // Neither may call the mutation directly — that would skip the confirmation
    // AND the copy that explains what a block actually cuts.
    expect(menu).not.toMatch(/useBlockUser\(|useUnblockUser\(/);
    expect(card).not.toMatch(/useBlockUser\(|useUnblockUser\(/);
  });

  it("kick and ban are confirmed, never fired from the menu row", () => {
    expect(menu).toMatch(/setMemberDialog\(\{\s*kind:\s*"kick"/);
    expect(menu).toMatch(/setMemberDialog\(\{\s*kind:\s*"ban"/);
    expect(menu).not.toMatch(/useKickMember\(|useBanMember\(/);
  });

  it("the confirmations own the mutations", () => {
    expect(dialogs).toMatch(/useUnfriend\(/);
    expect(dialogs).toMatch(/useKickMember\(/);
    expect(dialogs).toMatch(/useBanMember\(/);
  });
});
