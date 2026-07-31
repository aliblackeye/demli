---
name: copy-voice
description: Demli verbal identity enforcement for every user-facing string — product UI, landing, errors, notifications, store listings, release notes. Turkish-first authoring, tone map by surface, forbidden vocabulary, swap test. Use whenever a string enters or changes in packages/i18n or any founder-visible text is written.
---

# Copy Voice

## When to use
Any time user-facing text is written or changed: i18n catalog additions, landing/marketing
copy, error messages, empty states, notifications, dialogs, release notes, store listings.
Applies to BOTH languages — and to the order they are written in.

## Inputs
- `docs/product/brand-system.md` — the binding verbal identity: voice traits, tone map,
  forbidden vocabulary, onliness statement.
- The surface and state the string appears in (tone depends on it).

## Procedure
1. **Author Turkish first.** Demli's voice is Turkish; the English is a translation of the
   Turkish, never the reverse. English-first drafting produces translated-marketing slop in
   both languages at once.
2. **Place the string on the tone map** (brand-system §ton haritası, NN/g four dimensions).
   Error and loss-of-data moments: matter-of-fact, warm, zero playfulness. Marketing: casual,
   quietly confident, no hype. System/status text: plain. Tea-warmth is a marketing/empty-state
   spice, never an error-state one.
3. **Swap test per string block.** Replace "Demli" with a competitor's app name. If the
   sentence still holds, it is generic — rewrite around a true, specific fact (self-hosted,
   no ads, the actual behavior of the feature) or cut it.
4. **Scan against the forbidden vocabulary** (brand-system §yasak sözlük) — both TR and EN
   lists. One hit = rewrite.
5. **Concreteness rule.** Every claim must be checkable in the product ("oda kendini toparlar"
   is a claim about reconnect behavior — it must be true). No filler adjectives standing in
   for facts.
6. **Error copy rules** (CLAUDE.md §26): say what happened, what the app is doing about it,
   and what the user can do — in that order, no blame, no jokes, no raw codes.
7. Land the string in BOTH `packages/i18n` catalogs (tr + en) — the parity test fails
   otherwise. Never hardcode user-visible strings.

## Checklist
- [ ] Turkish authored first; English reads as native, not word-for-word
- [ ] Tone matches the surface per the tone map
- [ ] Every sentence block passes the swap test or states a Demli-specific fact
- [ ] Zero hits on the forbidden vocabulary (TR + EN)
- [ ] Claims are true and specific to shipped behavior
- [ ] Error copy: what happened → what's being done → what you can do
- [ ] Both catalogs updated, no hardcoded strings

## Output format
The strings themselves, TR and EN side by side, with a one-line tone note only where the
placement is non-obvious. No essay about the strings (CLAUDE.md §0.1).

## Failure conditions
BLOCK the string (do not commit it) if: authored English-first; fails the swap test without a
justifying specific fact; contains forbidden vocabulary; makes a claim the product does not
keep; jokes or exclaims inside an error state; is hardcoded instead of entering i18n; lands in
one catalog only. Blocked strings are rewritten, not waved through.
