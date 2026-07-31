/**
 * "A private note never leaves the viewer" — the CLIENT half of ADR 0019 §1.
 *
 * The API side is already defended by `apps/api/src/__tests__/user-notes.int.test.ts`,
 * which drives the target's own token against every plausible read. But the
 * client can leak a note the API guarded perfectly: fold it into a shared cache
 * entry, hand it to a projection a roster row renders, drop it into a payload
 * that gets logged. Those are structural mistakes, not behavioural ones, so this
 * is a SOURCE-level invariant test in the same spirit as the ADR's
 * "grep-checkable invariant" — the same trick used server-side to guarantee
 * nothing outside the note endpoint selects from `user_notes`.
 *
 * It fails loudly the moment a new file starts reading notes. When that is
 * legitimate, add the file to ALLOWED and state why — the point is that the
 * decision is made deliberately rather than by autocomplete.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RENDERER_SRC = fileURLToPath(new URL("..", import.meta.url));

/**
 * Files that may touch a note, and why:
 * - social-queries.ts — the ONLY place the endpoint is called from.
 * - query-client.ts   — declares the dedicated, non-`profile` cache key.
 * - MemberDialogs.tsx — the editor.
 * - ProfileCard.tsx   — renders it, on the VIEWER's own card of someone else,
 *                       under an explicit "only visible to you" label.
 * - MemberContextMenu.tsx — opens the editor (never reads the body).
 */
const ALLOWED = new Set([
  "queries/social-queries.ts",
  "lib/query-client.ts",
  "components/MemberDialogs.tsx",
  "components/ProfileCard.tsx",
  "components/MemberContextMenu.tsx",
]);

/** Anything that names the note API surface. */
const NOTE_REFERENCE = /\b(useUserNote|useSetUserNote|getUserNote|setUserNote|userNote)\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("private notes stay private (ADR 0019 §1)", () => {
  const files = walk(RENDERER_SRC);

  it("has a renderer to scan (guards against the walk silently finding nothing)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("is read by no module outside the note surface", () => {
    const offenders = files
      .filter((file) => NOTE_REFERENCE.test(readFileSync(file, "utf8")))
      .map((file) => relative(RENDERER_SRC, file).replace(/\\/g, "/"))
      .filter((file) => !ALLOWED.has(file));

    expect(offenders).toEqual([]);
  });

  it("never rides on the shared profile cache key", () => {
    // A note folded into `["profile", …]` would be handed to every component
    // that renders someone's card — including surfaces a third party sees.
    const queryClient = readFileSync(join(RENDERER_SRC, "lib/query-client.ts"), "utf8");
    expect(queryClient).toMatch(/userNote:\s*\(userId: UserId\)\s*=>\s*\["user-note", userId\]/);
  });

  it("is never written into the chat store's shared user directory", () => {
    // `chat-store.users` is projected into the roster, message rows, the mention
    // picker and the DM list — a note reaching it would render for everyone.
    const chatStore = readFileSync(join(RENDERER_SRC, "stores/chat-store.ts"), "utf8");
    expect(NOTE_REFERENCE.test(chatStore)).toBe(false);
    expect(chatStore).not.toMatch(/\bnote\b/i);
  });

  it("is not part of the shared roster projection", () => {
    // ShellMember feeds @demli/app-ui's MemberSidebar, which is rendered on
    // desktop AND web; a note field there would be a cross-surface leak.
    const shellData = readFileSync(
      fileURLToPath(
        new URL("../../../../../../packages/app-ui/src/data/shell-data.tsx", import.meta.url),
      ),
      "utf8",
    );
    expect(NOTE_REFERENCE.test(shellData)).toBe(false);
  });
});
