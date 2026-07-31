/**
 * EVERY mobile `<Avatar>` shows the user's real photo, and the exceptions are named.
 *
 * `Avatar` renders initials on a seeded colour when it has no image. That is a
 * good fallback and a terrible default: a caller that simply FORGOT `uri` got a
 * plausible-looking circle and no error anywhere — no warning, no blank box, no
 * failing test. The screen looked finished. It was not.
 *
 * That is how the four surfaces the founder actually complained about ended up
 * silently dropping the photo (2026-07-28: "odaya girmeden fotoğraf var, içeri
 * girince kayboluyor") — the voice/call tile grid, the voice room row + share
 * chip, the active-speaker PiP and the mention list — while the other 28 call
 * sites were fine. This is the mobile twin of the desktop bug fixed the same
 * day; see `apps/desktop/src/renderer/src/components/avatar-src-coverage.test.ts`.
 *
 * The real fix is in the type: `uri` is now REQUIRED on `Avatar`, so omitting it
 * fails the build. This test is the second half of that fix, and it guards the
 * loophole the type cannot see — a caller can still satisfy a required prop by
 * writing `uri={null}`, which compiles perfectly and renders exactly the bug we
 * just removed.
 *
 * So every `uri={null}` must be listed in {@link JUSTIFIED_NULL} with a reason.
 * Adding one is then a deliberate act with a defence, not a shortcut somebody
 * takes at 2am meaning to come back to it. If a surface genuinely has no avatar
 * to show, say so here; if it has one, pass it.
 *
 * Source-level on purpose: mounting these screens would drag in expo-router, the
 * LiveKit native module and every store — far more machinery than the thing it
 * protects. Same reasoning as the desktop original.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// From apps/mobile/src/components/ up to the repo root. Built with `join` on a
// plain string rather than `new URL(...)`: the mobile tsconfig pulls in RN's DOM
// lib, whose `URL` is not assignable to node:url's.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Every tree that renders the mobile `Avatar` — the router screens and the components. */
const SCANNED_TREES = [join("apps", "mobile", "app"), join("apps", "mobile", "src")] as const;

const AVATAR_SOURCE = join("apps", "mobile", "src", "components", "Avatar.tsx");

/**
 * Call sites that pass `uri={null}`, and why that is correct rather than lazy.
 * `count` is the number of `uri={null}` occurrences expected in that file, so a
 * NEW one in an already-listed file still fails until it is accounted for.
 */
const JUSTIFIED_NULL: Record<string, { count: number; reason: string }> = {
  "apps/mobile/src/components/member/AvatarLightbox.tsx": {
    count: 1,
    reason:
      "the `trimmedUrl == null` arm of the lightbox ternary — the user has no avatar image, " +
      "which is the only reason the lightbox is drawing initials at all",
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "android" || entry === "ios") {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * The opening tag starting at `start`, i.e. up to the first `>` that is not
 * inside a `{…}` expression or a string. Handles multi-line props and nested
 * braces (`uri={a ?? null}`), which a line-based regex would truncate.
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
      for (let i = text.indexOf("<Avatar"); i !== -1; i = text.indexOf("<Avatar", i + 1)) {
        // Skip `<AvatarLightbox` / `<AvatarTile`; only the component itself counts.
        if (/[A-Za-z0-9_]/.test(text[i + "<Avatar".length] ?? "")) continue;
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

describe("Avatar uri coverage", () => {
  it("finds the call sites at all (guards the scanner itself)", () => {
    // If a refactor moves these trees, the scanner would silently pass on zero
    // files and this whole suite would become decoration.
    expect(CALL_SITES.length).toBeGreaterThan(25);
  });

  it("every call site passes uri", () => {
    const missing = CALL_SITES.filter((s) => !/\buri=/.test(s.tag)).map(
      (s) => `${s.file}:${s.line}`,
    );
    expect(missing, "these <Avatar> call sites silently drop the user's photo").toEqual([]);
  });

  it("every uri={null} is justified in this file", () => {
    const actual: Record<string, number> = {};
    for (const site of CALL_SITES) {
      if (!/\buri=\{\s*null\s*\}/.test(site.tag)) continue;
      actual[site.file] = (actual[site.file] ?? 0) + 1;
    }

    const expected: Record<string, number> = {};
    for (const [file, { count }] of Object.entries(JUSTIFIED_NULL)) expected[file] = count;

    // Deliberately an equality, not a subset check: an UNLISTED `uri={null}` and a
    // listed one that quietly disappeared are both drift worth reading about.
    expect(
      actual,
      "an unlisted uri={null} is a silently missing avatar — pass the real one, " +
        "or add it to JUSTIFIED_NULL with the reason it has none",
    ).toEqual(expected);
  });

  it("documents a real reason for each justified null", () => {
    for (const [file, { reason }] of Object.entries(JUSTIFIED_NULL)) {
      expect(reason.length, `${file} needs an actual reason`).toBeGreaterThan(20);
    }
  });

  it("keeps uri REQUIRED on Avatar", () => {
    // The type is what makes forgetting impossible; the tests above only cover the
    // loophole it cannot see. Re-adding `?` would quietly restore the whole bug
    // class, and nothing else in the build would notice.
    const source = readFileSync(join(REPO_ROOT, AVATAR_SOURCE), "utf8");
    expect(source, "uri must stay required — see the prop's doc comment").toContain(
      "uri: string | null | undefined;",
    );
    expect(source, "uri must not become optional again").not.toMatch(/^\s*uri\?:/m);
  });
});
