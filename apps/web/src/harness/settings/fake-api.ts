/**
 * In-page FAKE backend for the settings-area harness (dev only).
 *
 * Replaces `window.fetch` for the configured API origin so the REAL query/
 * mutation hooks run end to end — reads, writes, invalidation, refetch — against
 * an in-memory store seeded from ./fixtures. Nothing is forwarded: an unknown
 * route answers 404 locally and is recorded on `window.__harness.unhandled`,
 * so this page can never reach the production API it would otherwise default
 * to. WebSocket is replaced with an inert stub for the same reason.
 *
 * Scenario knobs (URL params, read once at load):
 *   ?state=ideal|loading|error|empty   applies to every list read
 *   ?latency=<ms>                      per request (default 260)
 *   ?failWrites=1                      every mutation answers 500
 *   ?failReads=roles,details           only the TAGGED reads answer 500 (the
 *                                      rest stay ideal) — e.g. members load
 *                                      but their roles do not
 *
 * `window.__harness.remote` simulates another manager editing the server
 * (writes the store, then invalidates exactly what the realtime handler
 * would), so the draft guards can be proven against a refetch.
 */
import type { Invite, Role, User } from "@demli/types";
import {
  ALL_USERS,
  BLOCKS,
  CALLS_PAGE_1,
  CALLS_PAGE_2,
  CATEGORIES,
  CHANNELS,
  DMS,
  EMOJIS,
  EMOJI_URLS,
  FRIENDS,
  GROUP_CHAT,
  GROUP_CHAT_INVITES,
  GROUP_CHAT_MEMBERS,
  IGNORES,
  INCOMING,
  ME,
  MESSAGES,
  MOD_LOG_PAGE_1,
  MOD_LOG_PAGE_2,
  NICKNAMES,
  OUTGOING,
  ROLES,
  SERVER,
  SERVER_MEMBERS,
  SESSIONS,
} from "./fixtures";

export type ScenarioState = "ideal" | "loading" | "error" | "empty";

const params = new URLSearchParams(window.location.search);
export const scenarioState: ScenarioState = (["ideal", "loading", "error", "empty"] as const).includes(
  params.get("state") as ScenarioState,
)
  ? (params.get("state") as ScenarioState)
  : "ideal";
const latency = Number(params.get("latency") ?? 260);
const failWrites = params.get("failWrites") === "1";
const failReads = new Set((params.get("failReads") ?? "").split(",").filter(Boolean));

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

/* ── In-memory store ────────────────────────────────────────────────────── */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const empty = scenarioState === "empty";

const db = {
  server: clone(SERVER),
  channels: clone(CHANNELS),
  categories: clone(CATEGORIES),
  roles: empty ? [] : clone(ROLES),
  members: clone(SERVER_MEMBERS),
  emojis: empty ? [] : clone(EMOJIS),
  sessions: empty ? SESSIONS.filter((s) => s.current) : clone(SESSIONS),
  blocks: empty ? [] : clone(BLOCKS),
  ignores: empty ? [] : clone(IGNORES),
  nicknames: empty ? [] : clone(NICKNAMES),
  friends: empty ? [] : clone(FRIENDS),
  incoming: empty ? [] : clone(INCOMING),
  outgoing: empty ? [] : clone(OUTGOING),
  dms: clone(DMS),
  groupChat: clone(GROUP_CHAT),
  groupChatMembers: clone(GROUP_CHAT_MEMBERS),
  groupChatInvites: empty ? [] : clone(GROUP_CHAT_INVITES),
  channelAccess: { "c-oyunlar": ["r-oyuncu"] } as Record<string, string[]>,
  seq: 1,
};

const userById = (id: string): User | undefined => ALL_USERS.find((u) => u.id === id);
const nextId = (prefix: string): string => `${prefix}-${db.seq++}`;
const now = (): string => new Date().toISOString();

function makeInvite(groupId: string, body: { expiresInHours?: number; maxUses?: number; targetChannelId?: string }): Invite {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const code = Array.from({ length: 8 }, (_, i) => alphabet[(db.seq * 7 + i * 13) % alphabet.length]).join("");
  db.seq += 1;
  return {
    id: nextId("inv") as Invite["id"],
    groupId: groupId as Invite["groupId"],
    code,
    createdBy: ME.id,
    expiresAt: body.expiresInHours ? new Date(Date.now() + body.expiresInHours * 3_600_000).toISOString() : null,
    maxUses: body.maxUses ?? null,
    useCount: 0,
    createdAt: now(),
    targetChannelId: (body.targetChannelId ?? null) as Invite["targetChannelId"],
  };
}

/* ── Routes ─────────────────────────────────────────────────────────────── */

type Ctx = { method: string; path: string; query: URLSearchParams; body: Record<string, unknown>; m: string[] };
type Route = {
  method: string;
  pattern: RegExp;
  /** Honours ?state=loading|error (every read a surface depends on). */
  list?: boolean;
  /** Name for ?failReads=. */
  tag?: string;
  handle: (ctx: Ctx) => unknown;
};

const routes: Route[] = [
  // account
  { method: "GET", pattern: /^\/users\/me$/, handle: () => ({ user: ME }) },
  { method: "GET", pattern: /^\/sessions$/, list: true, handle: () => ({ sessions: db.sessions }) },
  {
    method: "DELETE",
    pattern: /^\/sessions\/others$/,
    handle: () => {
      const before = db.sessions.length;
      db.sessions = db.sessions.filter((s) => s.current);
      return { revoked: before - db.sessions.length };
    },
  },
  {
    method: "DELETE",
    pattern: /^\/sessions\/([^/]+)$/,
    handle: ({ m }) => {
      db.sessions = db.sessions.filter((s) => s.id !== m[1]);
    },
  },
  { method: "GET", pattern: /^\/users\/me\/blocks$/, list: true, handle: () => ({ blocks: db.blocks }) },
  {
    method: "DELETE",
    pattern: /^\/users\/me\/blocks\/([^/]+)$/,
    handle: ({ m }) => {
      db.blocks = db.blocks.filter((b) => b.user.id !== m[1]);
    },
  },
  { method: "GET", pattern: /^\/users\/me\/ignores$/, list: true, handle: () => ({ ignores: db.ignores }) },
  {
    method: "DELETE",
    pattern: /^\/users\/me\/ignores\/([^/]+)$/,
    handle: ({ m }) => {
      db.ignores = db.ignores.filter((b) => b.user.id !== m[1]);
    },
  },
  { method: "GET", pattern: /^\/users\/me\/nicknames$/, list: true, handle: () => ({ nicknames: db.nicknames }) },
  {
    method: "PUT",
    pattern: /^\/users\/([^/]+)\/nickname$/,
    handle: ({ m, body }) => {
      const nickname = (body.nickname as string | null) ?? null;
      db.nicknames = db.nicknames.filter((n) => n.user.id !== m[1]);
      const target = userById(m[1]!);
      if (nickname && target) db.nicknames.push({ user: target, nickname, updatedAt: now() });
      return { nickname };
    },
  },
  { method: "GET", pattern: /^\/users\/([^/]+)\/note$/, handle: () => ({ note: null }) },
  { method: "GET", pattern: /^\/notification-mutes$/, handle: () => ({ mutes: [] }) },
  { method: "GET", pattern: /^\/voice\/occupancy$/, handle: () => ({ channels: [] }) },
  { method: "GET", pattern: /^\/dm-calls\/active$/, handle: () => ({ call: null }) },

  // server
  { method: "GET", pattern: /^\/groups$/, handle: () => ({ groups: [db.server] }) },
  {
    method: "POST",
    pattern: /^\/groups$/,
    handle: ({ body }) => ({ group: { ...db.server, id: nextId("g"), name: String(body.name) } }),
  },
  {
    method: "GET",
    pattern: /^\/groups\/([^/]+)$/,
    list: true,
    tag: "details",
    handle: ({ m }) => {
      if (m[1] !== db.server.id) throw new HttpError(404, "NOT_FOUND");
      return { group: db.server, channels: db.channels, members: db.members };
    },
  },
  {
    method: "PATCH",
    pattern: /^\/groups\/([^/]+)$/,
    handle: ({ body }) => {
      db.server = { ...db.server, ...body } as typeof db.server;
      return { group: db.server };
    },
  },
  { method: "DELETE", pattern: /^\/groups\/([^/]+)$/, handle: () => undefined },
  {
    method: "POST",
    pattern: /^\/groups\/([^/]+)\/banner$/,
    handle: ({ body }) => {
      db.server = { ...db.server, bannerUrl: `data:${String(body.mime)};base64,${String(body.dataBase64)}` };
      return { group: db.server };
    },
  },
  {
    method: "DELETE",
    pattern: /^\/groups\/([^/]+)\/members\/([^/]+)$/,
    handle: ({ m }) => {
      db.members = db.members.filter((x) => x.userId !== m[2]);
    },
  },
  {
    method: "POST",
    pattern: /^\/groups\/([^/]+)\/members\/([^/]+)\/kick$/,
    handle: ({ m }) => {
      db.members = db.members.filter((x) => x.userId !== m[2]);
    },
  },
  {
    method: "PUT",
    pattern: /^\/groups\/([^/]+)\/members\/([^/]+)\/roles$/,
    handle: ({ m, body }) => {
      const roleIds = body.roleIds as Role["id"][];
      db.members = db.members.map((x) => (x.userId === m[2] ? { ...x, roleIds } : x));
      return { roleIds };
    },
  },
  {
    method: "GET",
    pattern: /^\/groups\/([^/]+)\/roles$/,
    list: true,
    tag: "roles",
    handle: () => ({ roles: db.roles }),
  },
  {
    method: "POST",
    pattern: /^\/groups\/([^/]+)\/roles$/,
    handle: ({ body }) => {
      const role: Role = {
        id: nextId("r") as Role["id"],
        groupId: db.server.id,
        name: String(body.name),
        color: (body.color as string | null) ?? null,
        position: db.roles.length,
        permissions: 0,
        createdAt: now(),
      };
      db.roles = [...db.roles, role];
      return { role };
    },
  },
  {
    method: "PATCH",
    pattern: /^\/groups\/([^/]+)\/roles\/([^/]+)$/,
    handle: ({ m, body }) => {
      db.roles = db.roles.map((r) => (r.id === m[2] ? ({ ...r, ...body } as Role) : r));
      return { role: db.roles.find((r) => r.id === m[2]) };
    },
  },
  {
    method: "DELETE",
    pattern: /^\/groups\/([^/]+)\/roles\/([^/]+)$/,
    handle: ({ m }) => {
      db.roles = db.roles.filter((r) => r.id !== m[2]);
      db.members = db.members.map((x) => ({ ...x, roleIds: (x.roleIds ?? []).filter((id) => id !== m[2]) }));
    },
  },
  {
    method: "GET",
    pattern: /^\/groups\/([^/]+)\/emojis$/,
    list: true,
    handle: () => ({ emojis: db.emojis, maxPerGroup: 50 }),
  },
  {
    method: "POST",
    pattern: /^\/groups\/([^/]+)\/emojis\/urls$/,
    handle: ({ body }) => ({
      urls: (body.emojiIds as string[]).map((emojiId) => ({
        emojiId,
        url: EMOJI_URLS[emojiId] ?? uploadedEmojiUrls[emojiId] ?? "",
        urlExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })),
    }),
  },
  {
    method: "POST",
    pattern: /^\/groups\/([^/]+)\/emojis$/,
    handle: ({ body }) => {
      if (db.emojis.some((e) => e.name === body.name)) throw new HttpError(409, "EMOJI_NAME_TAKEN");
      const id = nextId("e");
      uploadedEmojiUrls[id] = `data:${String(body.mime)};base64,${String(body.dataBase64)}`;
      const emoji = {
        id: id as (typeof db.emojis)[number]["id"],
        groupId: db.server.id,
        name: String(body.name),
        mime: String(body.mime),
        sizeBytes: Math.round((String(body.dataBase64).length * 3) / 4),
        createdBy: ME.id,
        createdAt: now(),
      };
      db.emojis = [...db.emojis, emoji];
      return { emoji };
    },
  },
  {
    method: "DELETE",
    pattern: /^\/groups\/([^/]+)\/emojis\/([^/]+)$/,
    handle: ({ m }) => {
      db.emojis = db.emojis.filter((e) => e.id !== m[2]);
    },
  },
  {
    method: "GET",
    pattern: /^\/groups\/([^/]+)\/moderation-log$/,
    list: true,
    handle: ({ query }) =>
      empty
        ? { entries: [], nextCursor: null }
        : query.get("before")
          ? { entries: MOD_LOG_PAGE_2, nextCursor: null }
          : { entries: MOD_LOG_PAGE_1, nextCursor: "page-2" },
  },
  { method: "GET", pattern: /^\/groups\/([^/]+)\/categories$/, handle: () => ({ categories: db.categories }) },
  {
    method: "POST",
    pattern: /^\/groups\/([^/]+)\/categories$/,
    handle: ({ body }) => {
      const category = { id: nextId("cat"), groupId: db.server.id, name: String(body.name), position: db.categories.length, createdAt: now() };
      db.categories = [...db.categories, category as (typeof db.categories)[number]];
      return { category };
    },
  },
  {
    method: "PATCH",
    pattern: /^\/categories\/([^/]+)$/,
    handle: ({ m, body }) => {
      db.categories = db.categories.map((c) => (c.id === m[1] ? { ...c, name: String(body.name) } : c));
      return { category: db.categories.find((c) => c.id === m[1]) };
    },
  },
  {
    method: "DELETE",
    pattern: /^\/categories\/([^/]+)$/,
    handle: ({ m }) => {
      db.categories = db.categories.filter((c) => c.id !== m[1]);
      db.channels = db.channels.map((c) => (c.categoryId === m[1] ? { ...c, categoryId: null } : c));
    },
  },
  {
    method: "POST",
    pattern: /^\/groups\/([^/]+)\/channels$/,
    handle: ({ body }) => {
      const created = {
        id: nextId("c"),
        groupId: db.server.id,
        kind: body.kind,
        name: String(body.name),
        position: db.channels.length,
        createdAt: now(),
        categoryId: (body.categoryId as string | undefined) ?? null,
        nsfw: Boolean(body.nsfw),
      } as (typeof db.channels)[number];
      db.channels = [...db.channels, created];
      return { channel: created };
    },
  },
  {
    method: "PATCH",
    pattern: /^\/channels\/([^/]+)$/,
    handle: ({ m, body }) => {
      db.channels = db.channels.map((c) => (c.id === m[1] ? ({ ...c, ...body } as typeof c) : c));
      return { channel: db.channels.find((c) => c.id === m[1]) };
    },
  },
  {
    method: "DELETE",
    pattern: /^\/channels\/([^/]+)$/,
    handle: ({ m }) => {
      db.channels = db.channels.filter((c) => c.id !== m[1]);
    },
  },
  {
    method: "GET",
    pattern: /^\/channels\/([^/]+)\/access$/,
    handle: ({ m }) => ({ roleIds: db.channelAccess[m[1]!] ?? [] }),
  },
  {
    method: "PUT",
    pattern: /^\/channels\/([^/]+)\/access$/,
    handle: ({ m, body }) => {
      db.channelAccess[m[1]!] = body.roleIds as string[];
      return { roleIds: body.roleIds };
    },
  },
  {
    method: "POST",
    pattern: /^\/groups\/([^/]+)\/invites$/,
    handle: ({ m, body }) => ({ invite: makeInvite(m[1]!, body as never) }),
  },
  {
    method: "POST",
    pattern: /^\/invites\/([^/]+)\/redeem$/,
    handle: ({ m }) => {
      if (m[1]!.toLowerCase().startsWith("x")) throw new HttpError(404, "NOT_FOUND");
      return { group: db.server, targetChannel: null };
    },
  },

  // channel streams (DM / group chat)
  {
    method: "GET",
    pattern: /^\/channels\/([^/]+)\/messages$/,
    handle: ({ m }) => ({ messages: [...(MESSAGES[m[1]!] ?? [])].reverse(), nextCursor: null }),
  },
  { method: "GET", pattern: /^\/channels\/([^/]+)\/pins$/, handle: () => ({ pins: [] }) },

  // social
  { method: "GET", pattern: /^\/friends$/, list: true, handle: () => ({ friends: db.friends }) },
  {
    method: "GET",
    pattern: /^\/friends\/requests$/,
    list: true,
    handle: ({ query }) => ({ requests: query.get("direction") === "outgoing" ? db.outgoing : db.incoming }),
  },
  {
    method: "POST",
    pattern: /^\/friends\/requests\/by-username$/,
    handle: ({ body }) => {
      const name = String(body.username);
      const target = ALL_USERS.find((u) => u.username === name);
      if (!target) throw new HttpError(404, "USER_NOT_FOUND");
      return { ok: true };
    },
  },
  {
    method: "POST",
    pattern: /^\/friends\/requests\/([^/]+)\/accept$/,
    handle: ({ m }) => {
      const request = db.incoming.find((r) => r.user.id === m[1]);
      db.incoming = db.incoming.filter((r) => r.user.id !== m[1]);
      if (request) db.friends = [...db.friends, { ...request, friendship: { ...request.friendship, status: "accepted" } }];
      return { friendship: request?.friendship };
    },
  },
  {
    method: "DELETE",
    pattern: /^\/friends\/requests\/([^/]+)$/,
    handle: ({ m }) => {
      db.incoming = db.incoming.filter((r) => r.user.id !== m[1]);
      db.outgoing = db.outgoing.filter((r) => r.user.id !== m[1]);
    },
  },
  { method: "GET", pattern: /^\/dms$/, handle: () => ({ dms: db.dms }) },
  {
    method: "POST",
    pattern: /^\/dms$/,
    handle: ({ body }) => ({ dm: db.dms.find((d) => d.participant.id === body.userId) ?? db.dms[0] }),
  },
  { method: "DELETE", pattern: /^\/dms\/([^/]+)$/, handle: () => undefined },
  {
    method: "POST",
    pattern: /^\/channels\/([^/]+)\/messages$/,
    handle: ({ m, body }) => ({
      message: {
        id: nextId("msg"),
        channelId: m[1],
        authorId: ME.id,
        content: String(body.content),
        kind: "user",
        createdAt: now(),
        updatedAt: null,
        attachments: [],
        reactions: [],
      },
    }),
  },
  {
    method: "GET",
    pattern: /^\/dm-calls\/recent$/,
    list: true,
    handle: ({ query }) =>
      empty
        ? { calls: [], nextCursor: null }
        : query.get("before")
          ? { calls: CALLS_PAGE_2, nextCursor: null }
          : { calls: CALLS_PAGE_1, nextCursor: "page-2" },
  },

  // group chats
  { method: "GET", pattern: /^\/group-chats$/, handle: () => ({ groups: [db.groupChat] }) },
  {
    method: "POST",
    pattern: /^\/group-chats$/,
    handle: ({ body }) => ({ group: { ...db.groupChat, id: nextId("gc"), name: String(body.name) } }),
  },
  {
    method: "GET",
    pattern: /^\/group-chats\/([^/]+)$/,
    list: true,
    handle: () => ({ group: db.groupChat, members: db.groupChatMembers }),
  },
  {
    method: "POST",
    pattern: /^\/group-chats\/([^/]+)\/members$/,
    handle: ({ body }) => {
      const target = ALL_USERS.find((u) => u.username === body.username);
      if (!target) throw new HttpError(404, "USER_NOT_FOUND");
      const added = { ...db.groupChatMembers[1]!, userId: target.id, user: target, role: "member" as const };
      db.groupChatMembers = [...db.groupChatMembers, added];
      return { member: added };
    },
  },
  {
    method: "DELETE",
    pattern: /^\/group-chats\/([^/]+)\/members\/([^/]+)$/,
    handle: ({ m }) => {
      db.groupChatMembers = db.groupChatMembers.filter((x) => x.userId !== m[2]);
    },
  },
  { method: "DELETE", pattern: /^\/group-chats\/([^/]+)$/, handle: () => undefined },
  {
    method: "GET",
    pattern: /^\/group-chats\/([^/]+)\/invites$/,
    list: true,
    handle: () => ({ invites: db.groupChatInvites }),
  },
  {
    method: "POST",
    pattern: /^\/group-chats\/([^/]+)\/invites$/,
    handle: ({ m, body }) => {
      const invite = makeInvite(m[1]!, body as never);
      db.groupChatInvites = [...db.groupChatInvites, invite];
      return { invite };
    },
  },
  {
    method: "DELETE",
    pattern: /^\/group-chats\/([^/]+)\/invites\/([^/]+)$/,
    handle: ({ m }) => {
      db.groupChatInvites = db.groupChatInvites.filter((i) => i.id !== m[2]);
    },
  },
];

const uploadedEmojiUrls: Record<string, string> = {};

/* ── fetch / WebSocket replacement ──────────────────────────────────────── */

interface HarnessGlobal {
  unhandled: string[];
  requests: { method: string; path: string; status: number }[];
  remote?: RemoteEdits;
}

/** Edits "another manager" makes, straight into the store (no request). */
export interface RemoteEdits {
  renameRole: (roleId: string, name: string) => void;
  renameServer: (name: string) => void;
}

export const remoteEdits: RemoteEdits = {
  renameRole: (roleId, name) => {
    db.roles = db.roles.map((r) => (r.id === roleId ? { ...r, name } : r));
  },
  renameServer: (name) => {
    db.server = { ...db.server, name };
  },
};

declare global {
  interface Window {
    __harness?: HarnessGlobal;
  }
}

const json = (status: number, payload: unknown): Response =>
  status === 204
    ? new Response(null, { status: 204 })
    : new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

const delay = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

/** Install once, before any query can fire. Every request to `apiBase` is answered here. */
export function installFakeBackend(apiBase: string): void {
  if (window.__harness) return;
  const harness: HarnessGlobal = { unhandled: [], requests: [] };
  window.__harness = harness;
  const realFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(apiBase)) {
      // Same-origin dev assets only; anything else is refused so the page
      // stays hermetic.
      if (url.startsWith(window.location.origin) || url.startsWith("/") || url.startsWith("data:")) {
        return realFetch(input, init);
      }
      harness.unhandled.push(`BLOCKED ${url}`);
      return json(503, { error: { code: "NETWORK", message: "blocked by harness" } });
    }
    const parsed = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = parsed.pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    await delay(latency);

    const route = routes.find((r) => r.method === method && r.pattern.test(path));
    if (!route) {
      harness.unhandled.push(`${method} ${path}`);
      harness.requests.push({ method, path, status: 404 });
      return json(404, { error: { code: "NOT_FOUND", message: "not in harness" } });
    }
    if (route.list && method === "GET" && scenarioState === "loading") {
      return new Promise<Response>(() => undefined);
    }
    if (method === "GET" && ((route.list && scenarioState === "error") || (route.tag && failReads.has(route.tag)))) {
      harness.requests.push({ method, path, status: 500 });
      return json(500, { error: { code: "INTERNAL", message: "harness error state" } });
    }
    if (method !== "GET" && failWrites) {
      harness.requests.push({ method, path, status: 500 });
      return json(500, { error: { code: "INTERNAL", message: "harness write failure" } });
    }
    try {
      const result = route.handle({ method, path, query: parsed.searchParams, body, m: path.match(route.pattern) ?? [] });
      const status = result === undefined ? 204 : 200;
      harness.requests.push({ method, path, status });
      return json(status, result);
    } catch (error) {
      if (error instanceof HttpError) {
        harness.requests.push({ method, path, status: error.status });
        return json(error.status, { error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  };

  /** Inert socket: never connects anywhere, never errors. */
  class InertWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = 0;
    url: string;
    onopen: ((event: Event) => void) | null = null;
    onclose: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    constructor(url: string | URL) {
      super();
      this.url = String(url);
      harness.unhandled.push(`WS ${this.url}`);
    }
    send(): void {}
    close(): void {
      this.readyState = 3;
    }
  }
  window.WebSocket = InertWebSocket as unknown as typeof WebSocket;
}
