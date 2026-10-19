/**
 * Fake API for the chat harness (DEV ONLY).
 *
 * The harness renders the REAL desktop chat surface — ChatView, the desktop
 * ChatDataProvider, the shared MessageList/MessageRow/MessageComposer and every
 * desktop slot (attachments, embeds, invite cards, pins, search, emoji). Those
 * read server state through the real `api` client, which calls `fetch`. This
 * module replaces `window.fetch` for the API origin only, answering from
 * ./fixtures with realistic latency and real error envelopes, so each surface
 * walks its genuine loading → data / error path instead of a hand-set state.
 *
 * Anything the fixtures do not answer is a 404 AND is recorded in
 * `window.__chatHarness.unhandled`, which the Playwright check asserts empty —
 * a component quietly hitting an endpoint nobody modelled fails the run.
 */
import {
  ATTACHMENT_URLS,
  BLOCKED_DM,
  CAN,
  CHANNELS,
  CUSTOM_EMOJI_URLS,
  CUSTOM_EMOJIS,
  GENEL_MESSAGES,
  GENEL_PINS,
  GROUP,
  GROUP_ID,
  INVITE_PREVIEWS,
  ME,
  MEMBERS,
  SLOW_MESSAGES,
} from "./fixtures";
import type { Message } from "@demli/types";

interface HarnessProbe {
  unhandled: string[];
  requests: string[];
}

declare global {
  interface Window {
    __chatHarness: HarnessProbe;
  }
}

const probe: HarnessProbe = { unhandled: [], requests: [] };
window.__chatHarness = probe;

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:4000";
/** Older pages are deliberately small so "load older" really pages in the harness. */
const PAGE_SIZE = 12;

const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

function json(body: unknown, status = 200): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function apiError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function page(all: Message[], cursor: string | null, limit: number): { messages: Message[]; nextCursor: string | null } {
  // `all` is oldest → newest; the API pages newest-first with a keyset cursor
  // (the id of the oldest message the previous page returned).
  const end = cursor ? all.findIndex((m) => m.id === cursor) : all.length;
  const stop = end < 0 ? all.length : end;
  const start = Math.max(0, stop - Math.min(limit, PAGE_SIZE));
  const slice = all.slice(start, stop).reverse();
  return { messages: slice, nextCursor: start > 0 ? (all[start]?.id ?? null) : null };
}

const MESSAGES_BY_CHANNEL: Record<string, Message[]> = {
  [CHANNELS.genel.id]: GENEL_MESSAGES,
  [CHANNELS.slow.id]: SLOW_MESSAGES,
  [CHANNELS.empty.id]: [],
  [CHANNELS.nsfw.id]: [],
  [BLOCKED_DM.streamId]: [],
};

type Handler = (match: RegExpMatchArray, url: URL, body: unknown) => Promise<Response> | Response;

const routes: { method: string; pattern: RegExp; handler: Handler }[] = [
  { method: "GET", pattern: /^\/users\/me$/, handler: () => json({ user: ME }) },
  {
    method: "GET",
    pattern: /^\/groups\/([^/]+)$/,
    handler: (m) =>
      m[1] === GROUP_ID
        ? json({ group: GROUP, channels: Object.values(CHANNELS), members: MEMBERS })
        : apiError(404, "NOT_FOUND", "Not found."),
  },
  { method: "GET", pattern: /^\/groups\/[^/]+\/roles$/, handler: () => json({ roles: [] }) },
  {
    method: "GET",
    pattern: /^\/groups\/[^/]+\/emojis$/,
    handler: () => json({ emojis: CUSTOM_EMOJIS, maxPerGroup: 64 }),
  },
  {
    method: "POST",
    pattern: /^\/groups\/[^/]+\/emojis\/urls$/,
    handler: (_m, _u, body) => {
      const ids = (body as { emojiIds?: string[] } | null)?.emojiIds ?? [];
      const expires = new Date(Date.now() + 60 * 60_000).toISOString();
      return json({
        urls: ids
          .filter((id) => CUSTOM_EMOJI_URLS[id])
          .map((id) => ({ emojiId: id, url: CUSTOM_EMOJI_URLS[id], urlExpiresAt: expires })),
      });
    },
  },
  {
    method: "GET",
    pattern: /^\/channels\/([^/]+)\/messages$/,
    handler: async (m, url) => {
      const channelId = m[1] ?? "";
      if (channelId === CHANNELS.loading.id) return new Promise<Response>(() => {});
      await wait(url.searchParams.get("cursor") ? 900 : 250);
      if (channelId === CHANNELS.error.id) {
        return apiError(500, "INTERNAL", "Something went wrong on our side. Please try again.");
      }
      const all = MESSAGES_BY_CHANNEL[channelId];
      if (!all) return apiError(404, "NOT_FOUND", "Not found.");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      return json(page(all, url.searchParams.get("cursor"), limit));
    },
  },
  {
    method: "GET",
    pattern: /^\/channels\/([^/]+)\/messages\/search$/,
    handler: async (m, url) => {
      await wait(450);
      const q = (url.searchParams.get("q") ?? "").toLocaleLowerCase("tr");
      if (q === "hata") return apiError(500, "INTERNAL", "Search failed.");
      if (q === "sınır") return apiError(429, "RATE_LIMITED", "Too many searches.");
      const all = MESSAGES_BY_CHANNEL[m[1] ?? ""] ?? [];
      const hits = all
        .filter((msg) => msg.kind !== "system" && msg.content.toLocaleLowerCase("tr").includes(q))
        .reverse();
      return json({ messages: hits, nextCursor: null });
    },
  },
  {
    method: "GET",
    pattern: /^\/channels\/([^/]+)\/pins$/,
    handler: async (m) => {
      await wait(350);
      return json({ pins: m[1] === CHANNELS.genel.id ? GENEL_PINS : [] });
    },
  },
  {
    method: "POST",
    pattern: /^\/channels\/[^/]+\/pins\/[^/]+$/,
    handler: () => apiError(409, "PINS_FULL", "Pin limit reached."),
  },
  { method: "DELETE", pattern: /^\/channels\/[^/]+\/pins\/[^/]+$/, handler: () => json(null, 204) },
  {
    method: "POST",
    pattern: /^\/channels\/([^/]+)\/attachments\/urls$/,
    handler: async (_m, _u, body) => {
      await wait(200);
      const ids = (body as { attachmentIds?: string[] } | null)?.attachmentIds ?? [];
      const expires = new Date(Date.now() + 60 * 60_000).toISOString();
      return json({
        urls: ids
          .filter((id) => ATTACHMENT_URLS[id])
          .map((id) => ({ attachmentId: id, url: ATTACHMENT_URLS[id], urlExpiresAt: expires })),
      });
    },
  },
  {
    method: "GET",
    pattern: /^\/invites\/([^/]+)\/preview$/,
    handler: async (m) => {
      await wait(600);
      const preview = INVITE_PREVIEWS[m[1] ?? ""];
      if (preview) return json({ preview });
      return apiError(410, "INVITE_EXPIRED", "This invite has expired.");
    },
  },
  {
    method: "POST",
    pattern: /^\/invites\/([^/]+)\/redeem$/,
    handler: async () => {
      await wait(700);
      return json({
        group: { ...GROUP, id: "g-oyun", name: "Bostancı Oyun Gecesi" },
        targetChannel: null,
      });
    },
  },
  {
    method: "PATCH",
    pattern: /^\/messages\/([^/]+)$/,
    handler: async (m, _u, body) => {
      await wait(300);
      const original = GENEL_MESSAGES.find((msg) => msg.id === m[1]);
      if (!original) return apiError(404, "NOT_FOUND", "Not found.");
      const content = (body as { content?: string } | null)?.content ?? original.content;
      return json({ message: { ...original, content, updatedAt: new Date().toISOString() } });
    },
  },
  {
    method: "DELETE",
    pattern: /^\/messages\/([^/]+)$/,
    handler: async () => {
      await wait(400);
      return apiError(403, "FORBIDDEN", "You can't delete this message.");
    },
  },
  { method: "GET", pattern: /^\/users\/me\/ignores$/, handler: () => json({ ignores: [] }) },
  { method: "GET", pattern: /^\/users\/me\/nicknames$/, handler: () => json({ nicknames: [] }) },
  {
    method: "GET",
    pattern: /^\/users\/me\/blocks$/,
    handler: () => json({ blocks: [{ user: CAN, createdAt: BLOCKED_DM.createdAt }] }),
  },
  { method: "GET", pattern: /^\/dms$/, handler: () => json({ dms: [BLOCKED_DM] }) },
];

const realFetch = window.fetch.bind(window);

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!href.startsWith(API_BASE)) return realFetch(input, init);
  const url = new URL(href);
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.pathname.replace(/\/+$/, "");
  probe.requests.push(`${method} ${path}`);
  let body: unknown = null;
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = null;
    }
  }
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = path.match(route.pattern);
    if (match) return route.handler(match, url, body);
  }
  probe.unhandled.push(`${method} ${path}`);
  return apiError(404, "NOT_FOUND", "Not modelled by the chat harness.");
};
