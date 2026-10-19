/**
 * EVERY `<UserAvatar>` shows the user's real photo, and the exceptions are named.
 *
 * `UserAvatar` renders initials on a seeded colour when it has no image. That is
 * a good fallback and a terrible default: a caller that simply FORGOT `src` got a
 * plausible-looking circle and no error anywhere — no warning, no blank box, no
 * failing test. The screen looked finished. It was not.
 *
 * That is how 20 of 35 call sites ended up silently dropping the avatar, including
 * the voice room and every call surface (founder, 2026-07-28: "sesli odada avatar
 * gelmiyor"). It had already been reported as a P0 twice before — `MemberSidebar`
 * and `MessageRow` — and both times it was patched one component at a time, which
 * fixed those two and did nothing about the next eighteen.
 *
 * The real fix is in the type: `src` is now REQUIRED on `UserAvatarProps`, so
 * omitting it fails the build. This test is the second half of that fix, and it
 * guards the loophole the type cannot see — a caller can still satisfy a required
 * prop by writing `src={null}`, which compiles perfectly and renders exactly the
 * bug we just removed.
 *
 * So every `src={null}` must be listed in {@link JUSTIFIED_NULL} with a reason.
 * Adding one is then a deliberate act with a defence, not a shortcut somebody
 * takes at 2am meaning to come back to it. If a surface genuinely has no avatar to
 * show, say so here; if it has one, pass it.
 *
 * Source-level on purpose: mounting ~35 components — each with its own store,
 * media and query graph — to assert one <img> would be far more machinery than
 * the thing it protects. Same reasoning as `update-badge-surfaces.test.ts`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));

/** Every tree that renders the shared `UserAvatar`. */
const SCANNED_TREES = [
  join("apps", "desktop", "src", "renderer", "src"),
  join("packages", "app-ui", "src"),
] as const;

const USER_AVATAR_SOURCE = join("packages", "ui", "src", "components", "user-avatar.tsx");

/**
 * Call sites that pass `src={null}`, and why that is correct rather than lazy.
 * `count` is the number of `src={null}` occurrences expected in that file, so a
 * NEW one in an already-listed file still fails until it is accounted for.
 */
const JUSTIFIED_NULL: Record<string, { count: number; reason: string }> = {
  "apps/desktop/src/renderer/src/components/UserFooter.tsx": {
    count: 1,
    reason:
      "the signed-out / not-yet-loaded branch — its condition IS `currentUser == null`, " +
      "so no user record exists to read an avatar from",
  },
  "apps/desktop/src/renderer/src/components/AvatarLightbox.tsx": {
    count: 1,
    reason:
      "the `url == null` arm of the lightbox ternary — the user has no avatar image, " +
      "which is the only reason the lightbox is drawing initials at all",
  },
  "packages/app-ui/src/__tests__/ui-primitives.test.tsx": {
    count: 1,
    reason:
      "a test fixture asserting the speaking ring and the 30% presence dot on the " +
      "INITIALS avatar — no user record and no photo are involved",
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "out") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * The opening tag starting at `start`, i.e. up to the first `>` that is not
 * inside a `{…}` expression or a string. Handles multi-line props and nested
 * braces (`src={a ?? null}`), which a line-based regex would truncate.
 */
function openingTagAt(text: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

interface CallSite {
  file: string;
  line: number;
  tag: string;
}

function findCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const tree of SCANNED_TREES) {
    for (const file of walk(join(REPO_ROOT, tree))) {
      const text = readFileSync(file, "utf8");
      const rel = relative(REPO_ROOT, file).split(sep).join("/");
      for (let i = text.indexOf("<UserAvatar"); i !== -1; i = text.indexOf("<UserAvatar", i + 1)) {
        // Skip `<UserAvatarSomethingElse`; only the component itself counts.
        if (/[A-Za-z0-9_]/.test(text[i + "<UserAvatar".length] ?? "")) continue;
        sites.push({
          file: rel,
          line: text.slice(0, i).split("\n").length,
          tag: openingTagAt(text, i),
        });
      }
    }
  }
  return sites;
}

const CALL_SITES = findCallSites();

describe("UserAvatar src coverage", () => {
  it("finds the call sites at all (guards the scanner itself)", () => {
    // If a refactor moves these trees, the scanner would silently pass on zero
    // files and this whole suite would become decoration.
    expect(CALL_SITES.length).toBeGreaterThan(25);
  });

  it("every call site passes src", () => {
    const missing = CALL_SITES.filter((s) => !/\bsrc=/.test(s.tag)).map(
      (s) => `${s.file}:${s.line}`,
    );
    expect(missing, "these <UserAvatar> call sites silently drop the user's photo").toEqual([]);
  });

  it("every src={null} is justified in this file", () => {
    const actual: Record<string, number> = {};
    for (const site of CALL_SITES) {
      if (!/\bsrc=\{\s*null\s*\}/.test(site.tag)) continue;
      actual[site.file] = (actual[site.file] ?? 0) + 1;
    }

    const expected: Record<string, number> = {};
    for (const [file, { count }] of Object.entries(JUSTIFIED_NULL)) expected[file] = count;

    // Deliberately an equality, not a subset check: an UNLISTED `src={null}` and a
    // listed one that quietly disappeared are both drift worth reading about.
    expect(
      actual,
      "an unlisted src={null} is a silently missing avatar — pass the real one, " +
        "or add it to JUSTIFIED_NULL with the reason it has none",
    ).toEqual(expected);
  });

  it("documents a real reason for each justified null", () => {
    for (const [file, { reason }] of Object.entries(JUSTIFIED_NULL)) {
      expect(reason.length, `${file} needs an actual reason`).toBeGreaterThan(20);
    }
  });

  it("keeps src REQUIRED on UserAvatarProps", () => {
    // The type is what makes forgetting impossible; the tests above only cover the
    // loophole it cannot see. Re-adding `?` would quietly restore the whole bug
    // class, and nothing else in the build would notice.
    const source = readFileSync(join(REPO_ROOT, USER_AVATAR_SOURCE), "utf8");
    expect(source, "src must stay required — see the prop's doc comment").toContain(
      "src: string | null | undefined;",
    );
    expect(source, "src must not become optional again").not.toMatch(/^\s*src\?:/m);
  });
});
