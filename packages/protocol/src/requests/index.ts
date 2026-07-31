/**
 * `@demli/protocol/requests` — the REST request contract.
 *
 * `schemas.ts` (a sibling, deliberately NOT merged into this directory) is the
 * WebSocket envelope contract: what the gateway accepts on a live socket. This
 * directory is the HTTP one: what a form submits and what an API route parses.
 * They validate different wires, at different moments, with different failure
 * modes, so they stay separate files that happen to share a package.
 *
 * The rule every schema here obeys: **no user-facing text**. A failure carries a
 * `ValidationCode` (see `codes.ts`), which `@demli/client-core`'s
 * `forms/issue-to-error.ts` turns into an i18n key. That is what keeps ADR 0009
 * intact while letting the API, which has no locale, run the same rules the form
 * ran — so the server can never enforce a rule the user was not shown.
 *
 * Bounds are imported from `@demli/config`, never written inline.
 */

export * from "./codes.js";
export * from "./common.js";
export * from "./common-passwords.js";
export * from "./text.js";

export * from "./auth.js";
export * from "./users.js";
export * from "./friends.js";
export * from "./groups.js";
export * from "./channels.js";
export * from "./categories.js";
export * from "./roles.js";
export * from "./invites.js";
export * from "./emojis.js";
export * from "./messages.js";
export * from "./watch.js";
export * from "./dm-calls.js";
