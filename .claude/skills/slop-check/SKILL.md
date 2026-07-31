---
name: slop-check
description: Adversarial post-production gate that measures whether founder-visible UI or copy is generic ("AI slop") using objective tests — swap test, template test, signature inventory, 5-state coverage, scenario walkthrough, banned patterns, voice audit. Run by a DIFFERENT agent than the producer, with screenshot evidence, before any merge or publish.
---

# Slop Check

## When to use
After production, before merge/publish, on any founder-visible surface (UI, landing, copy).
Runs ALONGSIDE `ui-quality-review` (that one checks structure/performance; this one checks
originality, coverage, and voice). Also run on generated design comps before they are adopted.

## Inputs
- The surface brief this work was produced against (`surface-brief` output). No brief → see
  Failure conditions.
- `docs/product/brand-system.md` (forbidden lists, tone map, onliness) and
  `docs/product/anti-slop-method.md` §4.
- Screenshots of every screen and state, or a running app. Diffs alone are not reviewable
  evidence for this gate.

## Hard rule: different eyes
The reviewer MUST be a different agent/session than the producer. A producer running
slop-check on its own output is a void result — the Director assigns the reviewer.

## Procedure
1. **Evidence check first.** Green typecheck/lint/tests are necessary but count for nothing
   here. If the work arrives with only test output and no visual + scenario evidence,
   stop: automatic FAIL until evidence exists.
2. **Swap test (copy).** Replace "Demli" with any competitor name across all new/changed
   sentences. Sentences that still hold are generic. >30% generic = FAIL; below that, list
   each generic sentence as a required rewrite.
3. **Template test (structure).** Describe the page/screen structure in one line. If it
   matches a default archetype (centered hero → N identical feature cards → CTA band →
   footer; generic tab-bar + card list; icon-title-body grid) with no declared deviation,
   FAIL.
4. **Signature inventory.** WITHOUT looking at the brief's declared moves, list the concrete
   elements a default generation would never produce. Then open the brief: if you found <3,
   or the declared moves were not actually shipped, FAIL.

   **Measure against the WORLD, not against our own documents.** `brand-system.md` was
   written by the same model being audited, so conformance to it proves nothing about
   originality — it can just as easily prove the defaults got written down. An element is a
   signature only if a default generation for this brief would NOT produce it. Ask directly:
   "if I asked a model for a landing page tomorrow with no brief at all, would this appear?"
   If yes, it is a default wearing a signature's name, and citing the brand doc for it is
   circular. This is not hypothetical — a full audit round passed a page whose typeface,
   palette, rules and reveal animation were the current default editorial set, because each
   one was listed in §8 and the reviewer checked conformance instead of rarity.

5. **House-default sweep (visual surfaces).** Name the surface's typeface(s), colour
   handling, edge/divider treatment, and motion. Any of these that is the current
   generated-UI default counts against the surface, and **three or four of them together is
   an automatic FAIL** regardless of what the brief declares — the combination is the tell,
   not any single choice. Known defaults as of 2026-07: Instrument Serif / Instrument Sans
   display pairing; cream or off-white "paper" with a warm earth ramp; 1px hairline rules as
   the only separator; opacity fade-up-on-scroll reveal. This list is expected to go stale —
   if a default is not on it, that is not a pass, it is a gap to name in the report.
6. **State coverage.** Demand the 5-state stack (blank/loading/partial/ideal/error) per
   screen, as screenshots. Missing error or empty state = FAIL.
7. **Scenario walkthrough.** Walk the brief's matrix cell by cell against the running
   surface/screenshots. Any DESIGN cell not demonstrably handled = FAIL.
8. **Banned pattern scan.** brand-system §yasaklar + this list: purple-to-cyan or any
   trend-gradient hero; glassmorphism/neon glow; bounce-on-hover; ≥3 identical
   icon-title-body cards; default lucide icon rows as decoration; stock-photo hero people;
   emoji as UI decoration; skeleton screens styled as the content's negative space nowhere
   else used. One hit = FAIL.
9. **Voice audit.** Run the changed strings through `copy-voice` checklist (tone map
   placement, forbidden vocabulary, TR-first evidence). Any blocked string = FAIL.
10. **Verdict.** PASS / FAIL with the per-test result. FAIL returns to the producer with the
   specific failing items; the fixed work re-enters at step 1. PASS still does not decide
   taste — taste forks go to the founder as 2-3 candidates.

## Checklist
- [ ] Reviewer ≠ producer
- [ ] Visual + scenario evidence present (not just green tests)
- [ ] Swap test ≤30% generic, rewrites listed
- [ ] Structure line does not match a default archetype undeclared
- [ ] ≥3 shipped signature moves found independently, judged against a DEFAULT
      generation — not against brand-system.md, which the same model wrote
- [ ] House-default sweep: typeface / colour / edges / motion named; not 3+ defaults
- [ ] 5-state stack evidenced per screen
- [ ] Every DESIGN matrix cell demonstrated
- [ ] Zero banned-pattern hits
- [ ] Voice audit clean

## Output format
Terse verdict in chat (CLAUDE.md §0.1): PASS/FAIL, then ONLY failing tests with evidence
(file/screen + what to change). Passing tests collapse to one line. Report file only if a
ship gate needs stored proof.

## Failure conditions
FAIL — blocks merge/publish — on any of: no surface brief existed (work is returned unreviewed);
producer self-review; evidence missing; any single test in steps 2-8 failing. This gate cannot
be overridden by a green build, by "the founder is waiting", or by any general design skill's
approval. Only the Director may consciously accept a specific listed failure, in writing, in
the merge decision.
