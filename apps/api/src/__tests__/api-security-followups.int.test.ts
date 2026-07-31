/**
 * The API half of the 2026-07-31 public-release security audit (integration).
 *
 * Real Postgres from docker-compose; auto-skipped when unreachable — and the
 * skip is LOUD, because the whole point of this file is that it actually runs.
 *
 * One finding per describe block:
 *
 *  2. `avatarUrl` / `bannerUrl` / `iconUrl` accepted ANY scheme. `z.string().url()`
 *     only asks whether `new URL()` parses, and it parses `javascript:`, `data:`
 *     and `file:`. The stored value is served to everyone who can see the user or
 *     the server, and mobile has no CSP behind it.
 *  3. `sanitizeText` was written for exactly this and the API never called it, so
 *     a display name / server name / channel name / custom status could be an
 *     RTL-flip or entirely invisible.
 *  4. `POST /groups/:groupId/channels` checked membership but never `kind`, so a
 *     group-DM owner could create channels no client can ever show.
 *  5. 24 authenticated GETs carried no rate limit at all, the heaviest being the
 *     message page (a blocked-author lookup + three batched enrichment queries).
 *  6. Every limit was keyed on the SESSION TOKEN, which is free to mint: log in
 *     N times, get N buckets.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyMigrations,
  createDb,
  createRepositories,
  generateSessionToken,
  hashSessionToken,
  sessionExpiresAt,
  type DbClient,
  type Repositories,
} from "@demli/db";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import { LIST_LIMIT, MESSAGE_PAGE_LIMIT, READ_LIMIT } from "../lib/rate-limit.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/demli";

async function isDbUp(): Promise<boolean> {
  const { sql, close } = createDb(DATABASE_URL, { max: 1 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await close();
  }
}

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn(
    "[api-security-followups.int.test] DATABASE unreachable — skipping integration tests",
  );
}

describe.skipIf(!dbUp)("API security follow-ups (audit 2026-07-31)", () => {
  let client: DbClient;
  let repos: Repositories;
  let app: FastifyInstance;

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let seq = 0;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  interface TestUser {
    id: string;
    username: string;
    token: string;
  }

  /** A user plus one session token. */
  async function newUser(label = "u"): Promise<TestUser> {
    seq += 1;
    const username = `${label}${seq}_${suffix}`;
    const user = await repos.users.create({
      username,
      displayName: username,
      passwordHash: "not-used",
    });
    return { id: user.id, username, token: await newSession(user.id) };
  }

  /** A SECOND (third, …) session for an existing user — what "log in again" gives. */
  async function newSession(userId: string): Promise<string> {
    const token = generateSessionToken();
    await repos.sessions.create({
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt: sessionExpiresAt(new Date(), 24),
    });
    return token;
  }

  async function makeServer(owner: TestUser): Promise<string> {
    seq += 1;
    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(owner.token),
      payload: { name: `srv_${suffix}_${seq}` },
    });
    expect(res.statusCode).toBe(201);
    return res.json().group.id as string;
  }

  async function makeGroupChat(owner: TestUser): Promise<string> {
    seq += 1;
    const res = await app.inject({
      method: "POST",
      url: "/group-chats",
      headers: auth(owner.token),
      payload: { name: `chat_${suffix}_${seq}` },
    });
    expect(res.statusCode).toBe(201);
    return res.json().group.id as string;
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    app = await buildApp({ repos, env: loadEnv({ DATABASE_URL }), logger: false });
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  // -------------------------------------------------------------------------
  // Finding 2 — URL scheme
  // -------------------------------------------------------------------------

  describe("media URLs accept http(s) and nothing else", () => {
    // Every one of these PARSES as a URL, which is all `z.string().url()` ever
    // checked. `javascript:` and `data:` are the classic sinks; `file:` reads the
    // viewer's disk; the last one is the reason the check must be anchored to the
    // scheme rather than "does it contain https://".
    const hostile = [
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "file:///etc/passwd",
      "javascript:/*https://x/*/alert(1)",
    ];

    it("refuses a non-http(s) avatarUrl on PATCH /users/me", async () => {
      const user = await newUser("avurl");
      for (const url of hostile) {
        const res = await app.inject({
          method: "PATCH",
          url: "/users/me",
          headers: auth(user.token),
          payload: { avatarUrl: url },
        });
        expect(res.statusCode, `avatarUrl=${url}`).toBe(400);
        expect(res.json().error.code).toBe("VALIDATION_ERROR");
      }
      // …and the row is untouched: nothing was stored on the way to the refusal.
      const me = await app.inject({ method: "GET", url: "/users/me", headers: auth(user.token) });
      expect(me.json().user.avatarUrl).toBeNull();
    });

    it("refuses a non-http(s) bannerUrl on PATCH /users/me", async () => {
      const user = await newUser("bnurl");
      const res = await app.inject({
        method: "PATCH",
        url: "/users/me",
        headers: auth(user.token),
        payload: { bannerUrl: "javascript:alert(1)" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("refuses a non-http(s) iconUrl on PATCH /groups/:groupId", async () => {
      const owner = await newUser("icurl");
      const groupId = await makeServer(owner);
      for (const url of hostile) {
        const res = await app.inject({
          method: "PATCH",
          url: `/groups/${groupId}`,
          headers: auth(owner.token),
          payload: { iconUrl: url },
        });
        expect(res.statusCode, `iconUrl=${url}`).toBe(400);
      }
    });

    it("still accepts a real https URL, and null to clear it", async () => {
      const user = await newUser("okurl");
      const set = await app.inject({
        method: "PATCH",
        url: "/users/me",
        headers: auth(user.token),
        payload: { avatarUrl: "https://cdn.example.com/a/b.png" },
      });
      expect(set.statusCode).toBe(200);
      expect(set.json().user.avatarUrl).toBe("https://cdn.example.com/a/b.png");

      const clear = await app.inject({
        method: "PATCH",
        url: "/users/me",
        headers: auth(user.token),
        payload: { avatarUrl: null },
      });
      expect(clear.statusCode).toBe(200);
      expect(clear.json().user.avatarUrl).toBeNull();

      // Case-insensitive scheme: `HTTPS://` is legal per RFC 3986 and must not be
      // collateral damage of the fix.
      const upper = await app.inject({
        method: "PATCH",
        url: "/users/me",
        headers: auth(user.token),
        payload: { avatarUrl: "HTTPS://cdn.example.com/a/b.png" },
      });
      expect(upper.statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Finding 3 — sanitizeText on identity-shaped text
  // -------------------------------------------------------------------------

  describe("identity text is sanitized server-side", () => {
    /** U+202E flips everything after it right-to-left in the line it lands in. */
    const RTL_OVERRIDE = "‮";
    /** Zero-width space — passes `min(1)`, renders as nothing. */
    const ZWSP = "​";

    it("strips the RTL override from a display name", async () => {
      const user = await newUser("rtl");
      const res = await app.inject({
        method: "PATCH",
        url: "/users/me",
        headers: auth(user.token),
        payload: { displayName: `Ali${RTL_OVERRIDE}gpj.exe` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.displayName).toBe("Aligpj.exe");
      expect(res.json().user.displayName).not.toContain(RTL_OVERRIDE);
    });

    it("refuses an all-invisible display name", async () => {
      const user = await newUser("inv");
      const res = await app.inject({
        method: "PATCH",
        url: "/users/me",
        headers: auth(user.token),
        payload: { displayName: ZWSP.repeat(5) },
      });
      expect(res.statusCode).toBe(400);
    });

    it("refuses an all-invisible display name at REGISTER", async () => {
      seq += 1;
      const res = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          username: `reginv${seq}_${suffix}`,
          password: "correct-horse-battery",
          displayName: ZWSP.repeat(3),
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it("strips invisible characters from a server name", async () => {
      const owner = await newUser("srvname");
      seq += 1;
      const res = await app.inject({
        method: "POST",
        url: "/groups",
        headers: auth(owner.token),
        payload: { name: `Cr${RTL_OVERRIDE}ew_${suffix}${seq}` },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().group.name).not.toContain(RTL_OVERRIDE);
    });

    it("strips invisible characters from a channel name", async () => {
      const owner = await newUser("chname");
      const groupId = await makeServer(owner);
      const res = await app.inject({
        method: "POST",
        url: `/groups/${groupId}/channels`,
        headers: auth(owner.token),
        payload: { name: `gen${RTL_OVERRIDE}eral`, kind: "text" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().channel.name).toBe("general");
    });

    it("strips invisible characters from a custom status", async () => {
      const user = await newUser("status");
      const res = await app.inject({
        method: "PUT",
        url: "/users/me/custom-status",
        headers: auth(user.token),
        payload: { text: `afk${RTL_OVERRIDE}${ZWSP}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.customStatus).toBe("afk");
    });

    it("leaves legitimate unicode alone (emoji ZWJ sequences, non-ASCII names)", async () => {
      const user = await newUser("uni");
      // A family emoji is three emoji held together by two ZERO WIDTH JOINERS.
      // ZWJ is `\p{Cf}` — the same category as the characters above — so a blanket
      // strip would silently shatter it into three separate people.
      const name = "Ayşe 👨‍👩‍👧 Şahin";
      const res = await app.inject({
        method: "PATCH",
        url: "/users/me",
        headers: auth(user.token),
        payload: { displayName: name },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.displayName).toBe(name);
    });
  });

  // -------------------------------------------------------------------------
  // Finding 4 — channel creation is servers-only
  // -------------------------------------------------------------------------

  describe("POST /groups/:groupId/channels is servers-only", () => {
    it("refuses a group chat with the same 404 a non-member gets", async () => {
      const owner = await newUser("gcown");
      const chatId = await makeGroupChat(owner);

      const res = await app.inject({
        method: "POST",
        url: `/groups/${chatId}/channels`,
        headers: auth(owner.token),
        payload: { name: "smuggled", kind: "text" },
      });
      // 404, not 403: whether an id names a server or a group DM is not something
      // the answer is allowed to disclose.
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("NOT_FOUND");
    });

    it("still lets a server owner create a channel", async () => {
      const owner = await newUser("srvown");
      const groupId = await makeServer(owner);
      const res = await app.inject({
        method: "POST",
        url: `/groups/${groupId}/channels`,
        headers: auth(owner.token),
        payload: { name: "ok-channel", kind: "text" },
      });
      expect(res.statusCode).toBe(201);
    });

    it("still 404s for a non-member of a real server", async () => {
      const owner = await newUser("srvown2");
      const stranger = await newUser("stranger");
      const groupId = await makeServer(owner);
      const res = await app.inject({
        method: "POST",
        url: `/groups/${groupId}/channels`,
        headers: auth(stranger.token),
        payload: { name: "nope", kind: "text" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Finding 5 — authenticated GETs carry a limit
  // -------------------------------------------------------------------------

  describe("authenticated GET routes are rate limited", () => {
    /**
     * `x-ratelimit-limit` is emitted by @fastify/rate-limit only for routes the
     * limiter actually covers, so its presence — and its VALUE — is a direct
     * readout of the route's configuration. That makes this a cheap assertion
     * over every previously-unlimited read instead of exhausting each one, and it
     * fails the moment a limit is dropped or silently retuned.
     */
    it("advertises a limit on every read that had none", async () => {
      const owner = await newUser("gets");
      const groupId = await makeServer(owner);
      const channels = await app.inject({
        method: "GET",
        url: `/groups/${groupId}/channels`,
        headers: auth(owner.token),
      });
      const channelId = channels.json().channels[0].id as string;

      const cases: Array<[string, number]> = [
        ["/users/me", READ_LIMIT.max],
        [`/users/${owner.id}`, READ_LIMIT.max],
        [`/users/${owner.id}/profile`, READ_LIMIT.max],
        [`/users/${owner.id}/note`, READ_LIMIT.max],
        ["/groups", LIST_LIMIT.max],
        [`/groups/${groupId}`, LIST_LIMIT.max],
        [`/groups/${groupId}/channels`, LIST_LIMIT.max],
        [`/groups/${groupId}/roles`, LIST_LIMIT.max],
        [`/groups/${groupId}/categories`, LIST_LIMIT.max],
        [`/groups/${groupId}/emojis`, LIST_LIMIT.max],
        [`/channels/${channelId}/access`, LIST_LIMIT.max],
        [`/channels/${channelId}/pins`, LIST_LIMIT.max],
        ["/dms", LIST_LIMIT.max],
        ["/friends", LIST_LIMIT.max],
        ["/friends/requests", LIST_LIMIT.max],
        ["/group-chats", LIST_LIMIT.max],
        ["/notification-mutes", LIST_LIMIT.max],
        ["/users/me/blocks", LIST_LIMIT.max],
        ["/users/me/ignores", LIST_LIMIT.max],
        ["/users/me/nicknames", LIST_LIMIT.max],
        ["/watch/capabilities", LIST_LIMIT.max],
        // The audit's named worst case: one call runs a blocked-author lookup and
        // three batched enrichment queries, and it was completely unmetered.
        [`/channels/${channelId}/messages`, MESSAGE_PAGE_LIMIT.max],
      ];

      for (const [url, max] of cases) {
        const res = await app.inject({ method: "GET", url, headers: auth(owner.token) });
        expect(res.headers["x-ratelimit-limit"], `no limit on GET ${url}`).toBe(String(max));
      }
    });

    // The header says a limit is CONFIGURED; this says it is ENFORCED. Driven on
    // the message page because that is the expensive read, using a budget-sized
    // burst rather than a trickle so the assertion is about the ceiling itself.
    it("actually 429s the message page past its budget", async () => {
      const owner = await newUser("msgcap");
      const groupId = await makeServer(owner);
      const channels = await app.inject({
        method: "GET",
        url: `/groups/${groupId}/channels`,
        headers: auth(owner.token),
      });
      const channelId = channels.json().channels[0].id as string;
      const url = `/channels/${channelId}/messages`;

      for (let i = 0; i < MESSAGE_PAGE_LIMIT.max; i += 1) {
        const res = await app.inject({ method: "GET", url, headers: auth(owner.token) });
        expect(res.statusCode, `request ${i + 1} of ${MESSAGE_PAGE_LIMIT.max}`).toBe(200);
      }
      const over = await app.inject({ method: "GET", url, headers: auth(owner.token) });
      expect(over.statusCode).toBe(429);
      expect(over.json().error.code).toBe("RATE_LIMITED");
    });
  });

  // -------------------------------------------------------------------------
  // Finding 6 — the bucket is the user, not the token
  // -------------------------------------------------------------------------

  describe("rate limits are keyed on the user, not the session token", () => {
    /**
     * `POST /users/me/friend-code/regenerate` is the cheapest authenticated route
     * with a small budget (5/min), which is what makes this pin affordable: eight
     * requests decide it.
     *
     * The two assertions have to be read TOGETHER — either alone is passable by a
     * wrong implementation:
     *
     *  - "a second token for the SAME user is already spent" fails under the old
     *    token-keyed behaviour, which handed the second login a fresh bucket;
     *  - "a DIFFERENT user is untouched" fails under IP keying, which every
     *    request in a test (and every household behind one NAT) would share.
     *
     * The second one is not hypothetical bookkeeping: @fastify/rate-limit installs
     * its check on `onRequest` by default, which runs BEFORE `authenticate`, so a
     * user-keyed generator that forgot `hook: "preHandler"` would read a null user
     * on every request and quietly degrade to exactly that IP bucket.
     */
    const REGEN_MAX = 5;
    const regenerate = (token: string, app_: FastifyInstance) =>
      app_.inject({
        method: "POST",
        url: "/users/me/friend-code/regenerate",
        headers: auth(token),
      });

    it("shares one bucket across every session of the same user", async () => {
      const user = await newUser("keyed");
      const secondToken = await newSession(user.id);
      const other = await newUser("keyed-other");

      // Spend the budget on the FIRST session.
      for (let i = 0; i < REGEN_MAX; i += 1) {
        const res = await regenerate(user.token, app);
        expect(res.statusCode, `request ${i + 1}`).toBe(200);
      }
      expect((await regenerate(user.token, app)).statusCode).toBe(429);

      // A freshly minted session for the SAME user buys no new allowance. Under
      // the old `keyGenerator: request.headers.authorization` this answered 200.
      expect((await regenerate(secondToken, app)).statusCode).toBe(429);

      // A DIFFERENT user, same IP (every inject shares 127.0.0.1), is untouched.
      // Under an IP key this answers 429.
      expect((await regenerate(other.token, app)).statusCode).toBe(200);
    });
  });
});
