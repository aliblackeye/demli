import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedisClient, RedisPresenceReader, type RedisClient } from "@demli/db";
import { derivePresenceStatus, publicPresenceStatus } from "@demli/types";
import { InMemoryPresenceStore, RedisPresenceStore, type PresenceStore } from "../presence.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

/** Shared behavioural contract, run against each PresenceStore implementation. */
function presenceContract(name: string, make: () => PresenceStore): void {
  describe(name, () => {
    it("derives online/offline from live connections", async () => {
      const store = make();
      expect(await store.getStatus("u1")).toBe("offline");

      expect(await store.connect("u1", "c1")).toBe(true); // first socket → online
      expect(await store.connect("u1", "c2")).toBe(false); // second socket
      expect(await store.getStatus("u1")).toBe("online");

      expect(await store.disconnect("u1", "c1")).toBe(false); // one socket remains
      expect(await store.disconnect("u1", "c2")).toBe(true); // went offline
      expect(await store.getStatus("u1")).toBe("offline");
    });

    it("is idempotent for repeated connect/disconnect of the same connection id", async () => {
      const store = make();
      expect(await store.connect("u2", "c1")).toBe(true);
      expect(await store.connect("u2", "c1")).toBe(false); // same id, still one socket
      expect(await store.getStatus("u2")).toBe("online");
      expect(await store.disconnect("u2", "c1")).toBe(true);
      expect(await store.disconnect("u2", "c1")).toBe(false); // already gone
      expect(await store.getStatus("u2")).toBe("offline");
    });

    it("honours manual status only while connected", async () => {
      const store = make();
      await store.setStatus("u3", "c1", "idle"); // not connected → ignored
      expect(await store.getStatus("u3")).toBe("offline");

      await store.connect("u3", "c1");
      await store.setStatus("u3", "c1", "idle");
      expect(await store.getStatus("u3")).toBe("idle");

      await store.setStatus("u3", "c1", "offline"); // not settable → falls back to online
      expect(await store.getStatus("u3")).toBe("online");

      await store.disconnect("u3", "c1");
      expect(await store.getStatus("u3")).toBe("offline");
    });

    it("ignores a status frame for a connection that is already gone", async () => {
      // The race the guard exists for: the frame lands after the socket closed.
      // Without it the hash keeps a field with no socket behind it and — these
      // keys carry no TTL — the user reads "idle" forever (ADR 0020's ghost).
      const store = make();
      await store.connect("u9", "live");
      await store.connect("u9", "dying");
      await store.disconnect("u9", "dying");
      await store.setStatus("u9", "dying", "idle");
      expect(await store.getStatus("u9")).toBe("online");
    });

    it("stores dnd and invisible verbatim (honest store — masking is the gateway's job)", async () => {
      const store = make();
      await store.connect("u8", "c1");

      await store.setStatus("u8", "c1", "dnd");
      expect(await store.getStatus("u8")).toBe("dnd");

      // "invisible" is a REAL stored status here — the store never masks it. The
      // gateway is what projects it to "offline" for peers (see publicPresenceStatus).
      await store.setStatus("u8", "c1", "invisible");
      expect(await store.getStatus("u8")).toBe("invisible");
      expect(await store.snapshot(["u8"])).toEqual([{ userId: "u8", status: "invisible" }]);
    });

    it("snapshots a mixed set of users", async () => {
      const store = make();
      await store.connect("a", "c1");
      await store.connect("b", "c1");
      await store.setStatus("b", "c1", "idle");
      expect(await store.snapshot(["a", "b", "c"])).toEqual([
        { userId: "a", status: "online" },
        { userId: "b", status: "idle" },
        { userId: "c", status: "offline" },
      ]);
    });

    // --- per-connection derivation (ADR 0020) ---------------------------------
    //
    // The founder's bug, at store level: a desktop auto-flips to "idle" and then
    // goes away while the phone stays connected and active. Pre-ADR the status was
    // ONE per-user key with no TTL, deleted only on the LAST disconnect — so the
    // dead desktop's "idle" outlived it and everyone saw the user as away.

    it("derives online when one connection is idle and another is active", async () => {
      const store = make();
      await store.connect("d1", "desktop");
      await store.connect("d1", "phone");
      await store.setStatus("d1", "desktop", "idle");
      await store.setStatus("d1", "phone", "online");
      expect(await store.getStatus("d1")).toBe("online");
      expect(await store.snapshot(["d1"])).toEqual([{ userId: "d1", status: "online" }]);
    });

    it("derives idle only when EVERY connection is idle", async () => {
      const store = make();
      await store.connect("d2", "desktop");
      await store.connect("d2", "phone");
      await store.setStatus("d2", "desktop", "idle");
      expect(await store.getStatus("d2")).toBe("online"); // phone still active
      await store.setStatus("d2", "phone", "idle");
      expect(await store.getStatus("d2")).toBe("idle"); // now all idle
    });

    it("re-derives when the ACTIVE connection drops (→ idle)", async () => {
      const store = make();
      await store.connect("d3", "desktop");
      await store.connect("d3", "phone");
      await store.setStatus("d3", "desktop", "idle");
      await store.setStatus("d3", "phone", "online");
      expect(await store.getStatus("d3")).toBe("online");

      await store.disconnect("d3", "phone");
      expect(await store.getStatus("d3")).toBe("idle"); // only the idle desktop left
    });

    it("re-derives when the IDLE connection drops (→ online) — the founder's bug", async () => {
      const store = make();
      await store.connect("d4", "desktop");
      await store.connect("d4", "phone");
      await store.setStatus("d4", "desktop", "idle");
      await store.setStatus("d4", "phone", "online");

      // The idle desktop closes. Pre-ADR its "idle" stayed in the per-user key and
      // the active phone kept reading "away" to every friend.
      await store.disconnect("d4", "desktop");
      expect(await store.getStatus("d4")).toBe("online");

      // And the last connection leaving is still plain offline.
      await store.disconnect("d4", "phone");
      expect(await store.getStatus("d4")).toBe("offline");
    });

    it("lets dnd on ONE device hold for the account (intent beats availability)", async () => {
      const store = make();
      await store.connect("d5", "phone");
      await store.connect("d5", "desktop");
      await store.setStatus("d5", "phone", "dnd");
      // The desktop re-asserts its own locally-remembered "online" on connect
      // (the 574537c client patch). Pre-ADR that last write stomped the phone's
      // dnd; now intent outranks a derived availability.
      await store.setStatus("d5", "desktop", "online");
      expect(await store.getStatus("d5")).toBe("dnd");

      // Turning dnd off on the phone releases the account.
      await store.setStatus("d5", "phone", "online");
      expect(await store.getStatus("d5")).toBe("online");
    });

    it("never unmasks invisible because another device is online", async () => {
      const store = make();
      await store.connect("d6", "desktop");
      await store.setStatus("d6", "desktop", "invisible");
      await store.connect("d6", "phone"); // seeded "online" on connect
      expect(await store.getStatus("d6")).toBe("invisible");
      // Even an explicit "online" from the other device cannot reveal them.
      await store.setStatus("d6", "phone", "online");
      expect(await store.getStatus("d6")).toBe("invisible");
    });

    it("ranks invisible above dnd", async () => {
      const store = make();
      await store.connect("d7", "desktop");
      await store.connect("d7", "phone");
      await store.setStatus("d7", "desktop", "invisible");
      await store.setStatus("d7", "phone", "dnd");
      expect(await store.getStatus("d7")).toBe("invisible");
    });

    it("seeds a new connection as online without disturbing an idle peer connection", async () => {
      const store = make();
      await store.connect("d8", "desktop");
      await store.setStatus("d8", "desktop", "idle");
      expect(await store.getStatus("d8")).toBe("idle");
      // A phone connects and says nothing yet — the seed alone makes them available.
      await store.connect("d8", "phone");
      expect(await store.getStatus("d8")).toBe("online");
    });

    // --- platform (task #47) --------------------------------------------------

    it("has no platform for an offline or platform-less user", async () => {
      const store = make();
      expect(await store.getPlatform("p0")).toBeUndefined(); // offline
      await store.connect("p0", "c1"); // connected, but no platform reported
      expect(await store.getPlatform("p0")).toBeUndefined();
    });

    it("reports the single connection's platform", async () => {
      const store = make();
      await store.connect("p1", "c1", "mobile");
      expect(await store.getPlatform("p1")).toBe("mobile");
    });

    it("lets desktop win over a concurrent mobile connection (dominance rule)", async () => {
      const store = make();
      await store.connect("p2", "mobileConn", "mobile");
      await store.connect("p2", "desktopConn", "desktop");
      expect(await store.getPlatform("p2")).toBe("desktop");

      // Desktop drops → falls back to the remaining mobile connection.
      await store.disconnect("p2", "desktopConn");
      expect(await store.getPlatform("p2")).toBe("mobile");
    });

    it("clears platform once the user goes fully offline", async () => {
      const store = make();
      await store.connect("p3", "c1", "mobile");
      await store.disconnect("p3", "c1");
      expect(await store.getPlatform("p3")).toBeUndefined();
    });

    it("carries the dominant platform into the snapshot", async () => {
      const store = make();
      await store.connect("s1", "c1", "mobile");
      await store.connect("s2", "mob", "mobile");
      await store.connect("s2", "desk", "desktop");
      expect(await store.snapshot(["s1", "s2"])).toEqual([
        { userId: "s1", status: "online", platform: "mobile" },
        { userId: "s2", status: "online", platform: "desktop" },
      ]);
    });
  });
}

presenceContract("InMemoryPresenceStore", () => new InMemoryPresenceStore());

// The peer-facing mask the gateway applies on every broadcast + handshake
// snapshot. Only "invisible" is hidden (→ offline); "dnd" stays a visible red dot.
describe("publicPresenceStatus (peer-facing mask)", () => {
  it("masks invisible to offline and passes every other status through", () => {
    expect(publicPresenceStatus("invisible")).toBe("offline");
    expect(publicPresenceStatus("online")).toBe("online");
    expect(publicPresenceStatus("idle")).toBe("idle");
    expect(publicPresenceStatus("dnd")).toBe("dnd");
    expect(publicPresenceStatus("offline")).toBe("offline");
  });
});

// The reduction both the gateway store and the API's RedisPresenceReader apply
// to a user's live connections (ADR 0020). Pinned directly as a pure rule so the
// priority ladder cannot drift without a failing test.
describe("derivePresenceStatus (live-connection reduction)", () => {
  it("is online when any connection is online, whatever the others say", () => {
    expect(derivePresenceStatus(["idle", "online"])).toBe("online");
    expect(derivePresenceStatus(["online", "idle", "idle"])).toBe("online");
  });

  it("is idle only when every connection is idle", () => {
    expect(derivePresenceStatus(["idle"])).toBe("idle");
    expect(derivePresenceStatus(["idle", "idle"])).toBe("idle");
  });

  it("ranks a deliberate dnd above derived availability", () => {
    expect(derivePresenceStatus(["online", "dnd"])).toBe("dnd");
    expect(derivePresenceStatus(["dnd", "idle"])).toBe("dnd");
  });

  it("ranks invisible above everything (never unmask a hidden user)", () => {
    expect(derivePresenceStatus(["invisible", "online"])).toBe("invisible");
    expect(derivePresenceStatus(["dnd", "invisible"])).toBe("invisible");
    expect(derivePresenceStatus(["idle", "online", "dnd", "invisible"])).toBe("invisible");
  });

  it("defaults to online for an empty bag or unrecognized values", () => {
    // Callers only reach this with ≥1 live connection, so "no declaration" means
    // "available" — the pre-status behavior for a client that never sends one.
    expect(derivePresenceStatus([])).toBe("online");
    expect(derivePresenceStatus([null, undefined])).toBe("online");
    expect(derivePresenceStatus(["garbage", "offline"])).toBe("online");
    // ...but a real declaration alongside garbage still wins.
    expect(derivePresenceStatus(["garbage", "idle"])).toBe("idle");
  });

  it("never derives offline (that means 'no connections' and is decided by the caller)", () => {
    expect(derivePresenceStatus(["offline"])).toBe("online");
    expect(derivePresenceStatus(["offline", "idle"])).toBe("idle");
  });
});

async function isRedisUp(): Promise<boolean> {
  const client = createRedisClient(REDIS_URL, { lazyConnect: true });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    await client.quit().catch(() => undefined);
  }
}

const redisUp = await isRedisUp();
if (!redisUp) {
  refuseToSkipIfRequired("redis");
  console.warn("[presence.test] REDIS unreachable — skipping RedisPresenceStore tests");
}

/** Distinct key namespace per store so the shared contract's fixed ids never collide. */
function uniquePrefix(base: string): string {
  return `${base}:${Math.random().toString(36).slice(2, 10)}`;
}

describe.skipIf(!redisUp)("RedisPresenceStore (live Redis)", () => {
  let redis: RedisClient;
  const prefix = `test:presence:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(() => {
    redis = createRedisClient(REDIS_URL);
    redis.on("error", () => undefined);
  });

  afterAll(async () => {
    // Sweep any keys this run created, then close.
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  presenceContract("contract", () => new RedisPresenceStore(redis, uniquePrefix(prefix)));

  it("resetAll wipes ghost connections left by a hard-killed predecessor", async () => {
    const ghostPrefix = uniquePrefix(`${prefix}:ghost`);
    // A "predecessor" registers sockets and then dies WITHOUT close() (deploy
    // kill) — its state stays in Redis and reads as online forever.
    const predecessor = new RedisPresenceStore(redis, ghostPrefix);
    await predecessor.connect("user-a" as never, "conn-1", "desktop");
    await predecessor.setStatus("user-a" as never, "conn-1", "idle");
    expect(await predecessor.getStatus("user-a" as never)).not.toBe("offline");

    // The fresh process wipes on startup; the ghost goes offline.
    const fresh = new RedisPresenceStore(redis, ghostPrefix);
    await fresh.resetAll();
    expect(await fresh.getStatus("user-a" as never)).toBe("offline");
    expect(await fresh.getPlatform("user-a" as never)).toBeUndefined();

    // New connections after the wipe register normally.
    expect(await fresh.connect("user-a" as never, "conn-2")).toBe(true);
    expect(await fresh.getStatus("user-a" as never)).toBe("online");
  });

  it("shares state across two store instances (cross-process semantics)", async () => {
    const sharedPrefix = uniquePrefix(`${prefix}:shared`);
    const a = new RedisPresenceStore(redis, sharedPrefix);
    const b = new RedisPresenceStore(redis, sharedPrefix);

    expect(await a.connect("u1", "conn-a")).toBe(true);
    // A different store instance (a second process) sees the same online user.
    expect(await b.getStatus("u1")).toBe("online");
    expect(await b.snapshot(["u1"])).toEqual([{ userId: "u1", status: "online" }]);

    // b registering a second connection does not re-trigger "came online".
    expect(await b.connect("u1", "conn-b")).toBe(false);
    expect(await a.disconnect("u1", "conn-a")).toBe(false); // conn-b still live
    expect(await b.disconnect("u1", "conn-b")).toBe(true); // now offline
    expect(await a.getStatus("u1")).toBe("offline");
  });

  // #110 — the WRITER (this store) and the push READER (@demli/db's
  // RedisPresenceReader, used by both apps/api and apps/realtime) share the Redis
  // `appstate` hash. This proves the cross-process seam end to end over REAL
  // Redis: the two agree on the "foreground" literal and the away gate flips
  // exactly as a phone backgrounds/foregrounds (the founder's push gap).
  it("app-state round-trip: reader.filterAway tracks the store's writes", async () => {
    const rtPrefix = uniquePrefix(`${prefix}:appstate`);
    const store = new RedisPresenceStore(redis, rtPrefix);
    const reader = new RedisPresenceReader(redis, rtPrefix);

    // Offline before any connection → away.
    expect(await reader.filterAway(["u"])).toEqual(["u"]);

    // Connect: seeded foreground → reachable, so NOT away (no push while looking).
    await store.connect("u" as never, "c1");
    expect(await reader.filterAway(["u"])).toEqual([]);

    // App backgrounds → the sole connection is background → away → push.
    await store.setAppState("u" as never, "c1", "background");
    expect(await reader.filterAway(["u"])).toEqual(["u"]);

    // A second, foreground connection (e.g. desktop) → reachable again.
    await store.connect("u" as never, "c2");
    expect(await reader.filterAway(["u"])).toEqual([]);

    // Back to foreground on c1, then drop c2 → still reachable.
    await store.setAppState("u" as never, "c1", "foreground");
    await store.disconnect("u" as never, "c2");
    expect(await reader.filterAway(["u"])).toEqual([]);

    // Last socket leaves → offline → away, and the appstate hash is cleaned up so
    // a late setAppState on the dead connection cannot resurrect a ghost.
    await store.disconnect("u" as never, "c1");
    expect(await reader.filterAway(["u"])).toEqual(["u"]);
    await store.setAppState("u" as never, "c1", "foreground"); // guarded no-op
    expect(await reader.filterAway(["u"])).toEqual(["u"]);
  });

  // --- live-deploy safety: pre-ADR-0020 keys are in production Redis RIGHT NOW --
  //
  // The old model wrote a per-USER `presence:status:{id}` STRING. The new model
  // uses a per-connection `presence:connstatus:{id}` HASH. The names differ
  // deliberately: reusing `:status:` for a hash would make every read of a
  // not-yet-wiped key fail with WRONGTYPE. These two tests are the proof.

  it("ignores a leftover pre-ADR-0020 per-user status STRING (no WRONGTYPE, no stale read)", async () => {
    const legacyPrefix = uniquePrefix(`${prefix}:legacy`);
    const store = new RedisPresenceStore(redis, legacyPrefix);
    // Exactly what an old gateway left behind: a TTL-less per-user status STRING,
    // stuck at "idle" because the desktop that set it never was the last to leave.
    await redis.set(`${legacyPrefix}:status:legacy-user`, "idle");

    // Every read path must work and must NOT adopt the legacy value.
    await store.connect("legacy-user" as never, "c1");
    expect(await store.getStatus("legacy-user" as never)).toBe("online");
    expect(await store.snapshot(["legacy-user" as never])).toEqual([
      { userId: "legacy-user", status: "online" },
    ]);
    await store.setStatus("legacy-user" as never, "c1", "dnd");
    expect(await store.getStatus("legacy-user" as never)).toBe("dnd");

    // The legacy key is untouched by the new code (it is simply ignored)...
    expect(await redis.get(`${legacyPrefix}:status:legacy-user`)).toBe("idle");
    // ...until the startup wipe, which is what actually removes it in production.
    await store.resetAll();
    expect(await redis.get(`${legacyPrefix}:status:legacy-user`)).toBeNull();
  });

  it("resetAll clears the new per-connection status hash too", async () => {
    const wipePrefix = uniquePrefix(`${prefix}:wipe`);
    const store = new RedisPresenceStore(redis, wipePrefix);
    await store.connect("w" as never, "c1");
    await store.setStatus("w" as never, "c1", "dnd");
    expect(await store.getStatus("w" as never)).toBe("dnd");

    await store.resetAll();
    expect(await store.getStatus("w" as never)).toBe("offline");
    expect(await redis.hvals(`${wipePrefix}:connstatus:w`)).toEqual([]);
  });

  // The WRITER (this store) and the API's READER (@demli/db) share the
  // `connstatus` hash and MUST reduce it the same way — otherwise the invite
  // card's online count and the presence dot disagree for the same user.
  it("status round-trip: reader.countPublicOnline derives over the same hash", async () => {
    const rtPrefix = uniquePrefix(`${prefix}:connstatus`);
    const store = new RedisPresenceStore(redis, rtPrefix);
    const reader = new RedisPresenceReader(redis, rtPrefix);

    expect(await reader.countPublicOnline(["u" as never])).toBe(0); // offline

    await store.connect("u" as never, "desktop");
    expect(await reader.countPublicOnline(["u" as never])).toBe(1);

    // Idle is still publicly online (amber dot, counted).
    await store.setStatus("u" as never, "desktop", "idle");
    expect(await reader.countPublicOnline(["u" as never])).toBe(1);

    // Invisible masks to offline → not counted...
    await store.setStatus("u" as never, "desktop", "invisible");
    expect(await reader.countPublicOnline(["u" as never])).toBe(0);
    // ...and a SECOND, plainly-online device must not reveal them.
    await store.connect("u" as never, "phone");
    await store.setStatus("u" as never, "phone", "online");
    expect(await reader.countPublicOnline(["u" as never])).toBe(0);
    expect(await store.getStatus("u" as never)).toBe("invisible");

    // Dropping the invisible connection releases the mask (nothing outlives it).
    await store.disconnect("u" as never, "desktop");
    expect(await reader.countPublicOnline(["u" as never])).toBe(1);

    await store.disconnect("u" as never, "phone");
    expect(await reader.countPublicOnline(["u" as never])).toBe(0);
  });

  it("close() clears this instance's own connections", async () => {
    const closePrefix = uniquePrefix(`${prefix}:close`);
    const store = new RedisPresenceStore(redis, closePrefix);
    await store.connect("u1", "c1");
    await store.connect("u2", "c1");
    expect(await store.getStatus("u1")).toBe("online");

    await store.close();

    const reader = new RedisPresenceStore(redis, closePrefix);
    expect(await reader.getStatus("u1")).toBe("offline");
    expect(await reader.getStatus("u2")).toBe("offline");
  });
});
