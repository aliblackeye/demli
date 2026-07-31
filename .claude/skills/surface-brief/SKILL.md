---
name: surface-brief
description: Mandatory pre-production gate for any founder-visible UI, landing, or copy work. Produces the binding surface brief (scenario matrix, 5-state stack, error copy first, interaction inventory, declared signature moves) that production must follow and slop-check verifies. No brief, no production.
---

# Surface Brief

## When to use
BEFORE starting any founder-visible surface work: landing pages, new screens, screen redesigns,
onboarding, empty states, marketing copy, store listings. Not needed for pure logic/backend
work or invisible refactors. The Director (or the agent it delegates to) writes the brief; the
producing agent receives it as its spec.

## Inputs
- `docs/product/brand-system.md` (binding: onliness, voice/tone map, forbidden lists, chosen
  visual direction) and `docs/product/anti-slop-method.md` §3-4.
- The task: which surface, which platforms (desktop/web/mobile — parity rule applies).
- Current state of the surface (screenshots or live app) if it exists.

## Procedure
1. **Purpose line.** One sentence: what this surface must make a real person do or feel.
   Tie it to the onliness statement — if the surface has no relation to what makes Demli
   Demli, say so explicitly (some surfaces are utilitarian; that is a legitimate answer).
2. **Scenario matrix.** Build the persona × entry-state × network × permission grid
   (anti-slop-method §3). Mark every cell DESIGN or N/A-with-reason. This is an input,
   not an afterthought.
3. **5-state stack per screen** (blank / loading / partial / ideal / error). Write the
   **error and empty state copy FIRST**, in Turkish first, following `copy-voice`. Only then
   describe the ideal state.
4. **Interaction inventory.** hover, focus-visible, keyboard path, long-text overflow,
   0-item and 100+-item lists, touch targets ≥44px on mobile, reduce-motion behavior.
5. **Structural sketch + signature moves.** Describe the layout in one line, then declare
   **≥3 signature moves**: concrete choices (structure, interaction, motif, copy) that a
   default generation would not produce. These are promises — `slop-check` verifies them.
   A signature move must be traceable to the brand system (tea motif, warm ramp, voice),
   not arbitrary weirdness.
6. **Reference set.** 2-3 named, current products/surfaces and ONE sentence each on what is
   being taken (a density decision, a state pattern — never "the look").
7. **Taste forks.** List every decision that is taste rather than correctness (palette
   application, type scale, motif treatment, headline). For each fork the plan is 2-3
   candidates for the founder (`founder-taste-calibration` memory rule). Single-take taste
   decisions are forbidden.
8. **Copy plan.** Which strings exist, drafted TR-first per `copy-voice`, and where they land
   in `packages/i18n` (both catalogs — parity test).
9. Deliver the brief in chat (or as the delegated agent's task text). A `docs/` file only if
   the wave spans multiple sessions/agents.

## Checklist
- [ ] Purpose line exists and is honest about onliness relevance
- [ ] Scenario matrix complete — every cell DESIGN or N/A-with-reason
- [ ] 5-state stack listed per screen; error/empty copy written before ideal
- [ ] Interaction inventory covers all items in step 4
- [ ] Structure described in one line + ≥3 signature moves declared and brand-traceable
- [ ] 2-3 named references with one-line takings
- [ ] Every taste fork has a 2-3 candidate plan for the founder
- [ ] Copy drafted TR-first, i18n destination named

## Output format
Terse (CLAUDE.md §0.1): the brief itself is the output — matrix, stack, inventory, moves,
forks. No prose narration around it.

## Failure conditions
BLOCK production (do not let implementation start) if: no brief exists for a founder-visible
surface; the matrix or 5-state stack is missing; fewer than 3 signature moves are declared;
error copy is deferred "until later"; a taste fork is planned as a single take; copy is
authored English-first. An agent that starts producing without a brief is stopped and
re-briefed — its unbriefed output is not reviewed, it is discarded.
