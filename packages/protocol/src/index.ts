/**
 * @demli/protocol — the single source of truth for realtime event names,
 * payload shapes, zod validation schemas, and typed event constructors.
 *
 * - events.ts    — payload DTOs + discriminated unions (CLAUDE.md §24)
 * - schemas.ts   — zod schemas validated at the gateway boundary
 * - factories.ts — typed constructors so no event-name string literal
 *                  ever appears outside this package
 * - mentions.ts  — the canonical `<@id>` mention wire encoding (shared by the
 *                  client tokenizer and the server mention detector)
 * - requests/    — the REST request contract: one zod schema per HTTP body,
 *                  query and params, so a form and the endpoint it posts to
 *                  enforce the SAME rules. Carries codes, never sentences —
 *                  `@demli/client-core`'s `forms/` turns them into i18n keys.
 */

export * from "./events.js";
export * from "./schemas.js";
export * from "./factories.js";
export * from "./mentions.js";
export * from "./requests/index.js";
