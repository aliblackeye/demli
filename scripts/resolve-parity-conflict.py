"""Resolve docs/product/feature-parity.md conflicts by TABLE ROW key.

Both sides append rows to the same tables, so git sees whole-hunk conflicts on a
file that has no real disagreement. Merging by the row's first cell keeps every
row from both sides.

This file's merge has bitten three times, each producing a clean-looking result
that was quietly wrong. Do not reintroduce any of them:

1. It deduped EVERY line, so blank lines (all keyed "") collapsed into one and
   shared table headers vanished — broken markdown inside a green merge.

2. It let "theirs" win a row both sides carried, on the assumption theirs is
   newer. It usually is not: an agent branch is based on whatever `origin/dev`
   was when it started, so a branch that never touched a feature still carries
   that feature's OLD row — and merging it reverted rows another agent had just
   flipped to ✅. Parity is a ship gate, so a silently reverted row is a lie in
   the one document release-check reads.

3. It keyed HEADER and SEPARATOR rows too. Every table starts
   `| Özellik | Masaüstü | Mobil |`, so all of them collapsed onto one key across
   the whole hunk and tables lost their heads — bug 1 again, by another route.
   Only rows INSIDE a table body are keyed; a header is recognised as the row
   that precedes a `|---|` separator.

Rows that genuinely differ are NOT resolved automatically: ours is kept, the pair
is printed, and the exit code is non-zero so it cannot be run and forgotten.
"""

from __future__ import annotations

import re
import sys

PATH = "docs/product/feature-parity.md"
CONFLICT = re.compile(r"<<<<<<< [^\n]*\n(.*?)\n?=======\n(.*?)\n?>>>>>>> [^\n]*\n", re.S)
SEPARATOR = re.compile(r"^\s*\|[\s:|-]+\|\s*$")

# Windows consoles default to cp1254 here and die on ✅. The report is diagnostic;
# a mangled glyph is fine, a crash that hides the report is not.
sys.stdout.reconfigure(errors="replace")

disputed: list[tuple[str, str]] = []


def is_row(line: str) -> bool:
    return line.lstrip().startswith("|")


def classify(lines: list[str]) -> list[str | None]:
    """Per line: a body row's key, or None for prose / header / separator.

    A table is `header, separator, body…`. Only body rows carry identity — a
    header is shared by every table in the document and a separator has no
    content at all, so keying either merges unrelated tables together.
    """
    keys: list[str | None] = []
    in_body = False
    for i, line in enumerate(lines):
        if not is_row(line):
            in_body = False
            keys.append(None)
            continue
        if SEPARATOR.match(line):
            in_body = True
            keys.append(None)
            continue
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        if SEPARATOR.match(nxt):  # this is the header of a starting table
            in_body = False
            keys.append(None)
            continue
        if not in_body:  # a stray row with no header — leave it alone
            keys.append(None)
            continue
        cells = line.strip().strip("|").split("|")
        keys.append(cells[0].strip().lower() if cells else None)
    return keys


def merge(match: re.Match[str]) -> str:
    ours, theirs = match.group(1).split("\n"), match.group(2).split("\n")
    out: list[str] = []
    row_at: dict[str, int] = {}
    seen_prose: set[str] = set()

    for side, lines in (("ours", ours), ("theirs", theirs)):
        keys = classify(lines)
        for line, key in zip(lines, keys):
            if key is not None:
                if key in row_at:
                    if out[row_at[key]].strip() != line.strip():
                        disputed.append((out[row_at[key]], line))
                    # Keep ours — see note 2 above.
                else:
                    row_at[key] = len(out)
                    out.append(line)
                continue
            if side == "ours":
                out.append(line)
                if line.strip():
                    seen_prose.add(line.strip())
            elif line.strip() and line.strip() not in seen_prose:
                out.append(line)
    return "\n".join(out) + "\n"


text = open(PATH, encoding="utf-8").read()
merged, blocks = CONFLICT.subn(merge, text)
open(PATH, "w", encoding="utf-8", newline="\n").write(merged)

left = merged.count("<<<<<<<") + merged.count(">>>>>>>")
print(f"blocks={blocks} markers_left={left} disputed_rows={len(disputed)}")
for ours_row, theirs_row in disputed:
    print("  DISPUTED — kept ours, CHECK THE TREE before trusting either:")
    print(f"    ours  : {ours_row.strip()[:160]}")
    print(f"    theirs: {theirs_row.strip()[:160]}")

sys.exit(1 if (left or disputed) else 0)
