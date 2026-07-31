/**
 * The gap between the author name and the timestamp must not depend on the
 * author element having a box.
 *
 * `space-x-*` puts the margin on the LATER sibling. The desktop surface wraps
 * the author name in `<span className="contents">` so the profile-card and
 * context-menu plumbing adds no layout box — and an element with
 * `display: contents` generates no box, so a margin on it does nothing at all.
 * The class was present, the CSS was correct, and the gap was zero: every
 * message in every channel and DM rendered as "KeremBugün 13:59".
 *
 * Nothing failed. The utility silently no-opped, and it shipped in a README
 * screenshot that was reviewed and called clean. The founder found it.
 *
 * So the rule is: this header sets its gutter with margins on the LATER items,
 * which are elements this file controls, never with a container utility whose
 * effect depends on what a surface does with the earlier ones.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "components", "MessageRow.tsx"),
  "utf8",
);
/** Comments explain the ban and must not trip it. */
const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The `!isContinuation` header row: author name, optional badge, timestamp. */
const header = /<div className="flex items-baseline[^"]*">([\s\S]*?)<\/div>/.exec(code);

describe("message header gutter", () => {
  it("finds the header row at all", () => {
    // If this fails the markup was restructured and the assertions below stopped
    // guarding anything — which is worse than a red test.
    expect(header).not.toBeNull();
    expect(header?.[1]).toContain("renderAuthorName");
  });

  it("does not space the header with a container utility", () => {
    const container = /<div className="(flex items-baseline[^"]*)">/.exec(code)?.[1] ?? "";
    expect(container).not.toMatch(/\bspace-x-/);
    // `gap` is also out, and for a different reason: the web build still targets
    // Safari 12, which has no flex gap. It would look right here and be glued
    // there — the harder bug to notice.
    expect(container).not.toMatch(/\bgap-/);
  });

  it("puts a left margin on the timestamp", () => {
    const body = header?.[1] ?? "";
    expect(body).toMatch(/className="ml-2 [^"]*text-fg-faint"/);
  });

  it("puts a left margin on the timeout badge too", () => {
    const body = header?.[1] ?? "";
    expect(body).toMatch(/<TimeoutBadge[\s\S]{0,120}?className="ml-2"/);
  });
});
