/**
 * @demli/unfurl — server-side link-preview (unfurl) for M17.
 *
 * A shared package (mirroring @demli/notifications) because BOTH message
 * creation paths must unfurl: REST creates in `apps/api`, WebSocket `message.send`
 * creates in `apps/realtime`. Duplicating the SSRF-critical fetch/parse across
 * two processes is exactly the drift CLAUDE.md §28 forbids, so the guard lives
 * here once and each app instantiates one service in its composition root.
 *
 * - ssrf.ts      — IP blocklist (private/loopback/link-local/metadata, v4+v6)
 * - fetcher.ts   — SSRF-guarded, redirect-revalidating, capped HTTP fetch
 * - parse.ts     — regex OpenGraph/meta parser (no cheerio — see its header)
 * - urls.ts      — http(s) URL extraction from message content
 * - service.ts   — orchestration: cache, per-user rate cap, persist, publish
 */

export * from "./constants.js";
export * from "./ssrf.js";
export * from "./urls.js";
export * from "./parse.js";
export * from "./fetcher.js";
export * from "./service.js";
