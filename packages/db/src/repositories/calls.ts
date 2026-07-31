import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type {
  CallId,
  CallMedia,
  CallStatus,
  DmCall,
  DmId,
  GroupId,
  User,
  UserId,
} from "@demli/types";
import type { Db } from "../client.js";
import { toDmCall, toUser, type DmCallRow, type UserRow } from "../mappers.js";
import { buildMessagesPage, decodeMessageCursor, type MessagesPage } from "../pagination.js";
import { dmCalls, users } from "../schema.js";

/**
 * LiveKit room-name prefix for a DM call's EPHEMERAL room (ADR 0012 §2). A call
 * room is never a channel id — it is `dmcall:<callId>`, so the single-session
 * registry keys on it unchanged and it never collides with a voice channel.
 */
export const DM_CALL_ROOM_PREFIX = "dmcall:";

/** The canonical LiveKit room name for a call id: `dmcall:<id>`. */
export function dmCallRoomName(id: CallId): string {
  return `${DM_CALL_ROOM_PREFIX}${id}`;
}

/**
 * The two "live" statuses — the exact predicate of the `dm_calls_one_live_per_dm`
 * partial unique index. A DM has at most one row in these states at a time.
 */
const LIVE_STATUSES = ["ringing", "active"] as const satisfies readonly CallStatus[];

/** Recent-calls page size (Voice-UX #2): default 25, clamped to 1..50. */
export const RECENT_CALLS_DEFAULT_LIMIT = 25;
export const RECENT_CALLS_MAX_LIMIT = 50;

/**
 * Safety ceiling on one liveness-sweep batch. A DM call is a 1-1 conversation,
 * so the number of genuinely live rows at any instant is tiny; this only bounds
 * a pathological backlog (e.g. the first sweep after a long-running ghost-call
 * bug) into repeated, predictable ticks instead of one unbounded query.
 */
export const LIVE_CALLS_SWEEP_LIMIT = 500;

/** Which side of a call the viewer was on. */
export type RecentCallDirection = "incoming" | "outgoing";

/**
 * One row of a user's cross-DM call history (Voice-UX #2). A read-only, wire-safe
 * projection of a `dm_calls` row relative to the viewer:
 * - `peer`             — the OTHER participant (the public {@link User}, no
 *   friendCode), resolved by the join so the client never re-fetches.
 * - `direction`        — the viewer's role: `outgoing` when they placed the call,
 *   `incoming` when they were rung.
 * - `durationSeconds`  — talk time (`endedAt - startedAt`), present ONLY for a
 *   connected-then-hung-up call (`status === "ended"`); null for every other
 *   outcome (missed / declined / canceled / upgraded / still-live never carry a
 *   settled duration).
 */
export interface RecentCall {
  id: CallId;
  dmId: DmId;
  peer: User;
  media: CallMedia;
  status: CallStatus;
  direction: RecentCallDirection;
  durationSeconds: number | null;
  createdAt: string;
}

/**
 * Project a joined `dm_calls` row into a {@link RecentCall} relative to `viewerId`.
 * `durationSeconds` is settled only for an `ended` call with both stamps.
 */
function toRecentCall(row: DmCallRow, peer: UserRow, viewerId: UserId): RecentCall {
  const direction: RecentCallDirection = row.callerId === viewerId ? "outgoing" : "incoming";
  const durationSeconds =
    row.status === "ended" && row.startedAt !== null && row.endedAt !== null
      ? Math.max(0, Math.round((row.endedAt.getTime() - row.startedAt.getTime()) / 1000))
      : null;
  return {
    id: row.id,
    dmId: row.dmId,
    peer: toUser(peer),
    media: row.media,
    status: row.status,
    direction,
    durationSeconds,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Query layer for `dm_calls` (ADR 0012 §7) — the control-plane record and the
 * live-call source of truth. Media itself lives on LiveKit; this table only logs
 * the attempt and drives idempotent start via the live-per-DM unique index.
 */
export function callsRepo(db: Db) {
  return {
    /**
     * Log a fresh call attempt (status `ringing`). The call id is generated here
     * so `roomName` can be derived deterministically as `dmcall:<id>` — the room
     * name is a pure function of the id, kept in one place so it can never drift.
     * The `dm_calls_one_live_per_dm` partial unique index means a second live
     * call on the same DM throws a unique violation (the API maps that to
     * 409 / returns the existing call).
     */
    async create(input: {
      dmId: DmId;
      callerId: UserId;
      calleeId: UserId;
      media: CallMedia;
      /** Ring deadline (`createdAt + RING_TIMEOUT`); null leaves it open. */
      expiresAt?: Date | null;
    }): Promise<DmCall> {
      const id = randomUUID();
      const [row] = await db
        .insert(dmCalls)
        .values({
          id,
          dmId: input.dmId,
          roomName: dmCallRoomName(id),
          callerId: input.callerId,
          calleeId: input.calleeId,
          media: input.media,
          status: "ringing",
          expiresAt: input.expiresAt ?? null,
        })
        .returning();
      if (!row) throw new Error("insert dm_calls returned no row");
      return toDmCall(row);
    },

    async findById(id: CallId): Promise<DmCall | null> {
      const [row] = await db.select().from(dmCalls).where(eq(dmCalls.id, id)).limit(1);
      return row ? toDmCall(row) : null;
    },

    /**
     * The single live (`ringing` | `active`) call for a DM, or null. The partial
     * unique index guarantees at most one, so `limit(1)` is exact.
     */
    async findLiveForDm(dmId: DmId): Promise<DmCall | null> {
      const [row] = await db
        .select()
        .from(dmCalls)
        .where(and(eq(dmCalls.dmId, dmId), inArray(dmCalls.status, [...LIVE_STATUSES])))
        .limit(1);
      return row ? toDmCall(row) : null;
    },

    /**
     * The ONE live (`ringing` | `active`) call this user is part of — either side
     * — or null. Backs `GET /dm-calls/active`, the call-plane state resync
     * (call-UX plan K2.2): after a reconnect or an out-of-phase `call.accepted`
     * the client asks "what am I actually in?" and re-seats on this row.
     *
     * The `dm_calls_one_live_per_dm` index bounds live rows per DM, not per USER,
     * so a user can legitimately hold two at once (ringing out in DM A while
     * being rung in DM B). The order therefore MATTERS and is not cosmetic:
     * `active` outranks `ringing`, then newest first. An accepted call is where
     * the user's media actually is, so a resync must never hand back a ring that
     * would pull them out of a live conversation.
     *
     * Served by the two partial indexes from migration 0023
     * (`dm_calls_live_caller_id` / `dm_calls_live_callee_id`), which index only
     * live rows — a handful at any instant — so this stays a cheap lookup even as
     * the call log grows, and it is called on every socket (re)connect.
     */
    async findLiveForUser(userId: UserId): Promise<DmCall | null> {
      const [row] = await db
        .select()
        .from(dmCalls)
        .where(
          and(
            inArray(dmCalls.status, [...LIVE_STATUSES]),
            or(eq(dmCalls.callerId, userId), eq(dmCalls.calleeId, userId)),
          ),
        )
        .orderBy(
          sql`case when ${dmCalls.status} = 'active' then 0 else 1 end`,
          desc(dmCalls.createdAt),
        )
        .limit(1);
      return row ? toDmCall(row) : null;
    },

    /**
     * The newest call on a DM by `created_at` (newest first), or null — regardless
     * of status. Backs the start handler's ring hardening (security F2): the newest
     * row is either the current live ring, a stale ring past its deadline, or the
     * last terminal attempt, and start inspects it to sweep a stuck ring and to
     * enforce the per-DM start cooldown. Served by the `dm_calls_dm_id_created_at`
     * index; `id` breaks the (theoretical) same-instant tie deterministically.
     */
    async findLatestForDm(dmId: DmId): Promise<DmCall | null> {
      const [row] = await db
        .select()
        .from(dmCalls)
        .where(eq(dmCalls.dmId, dmId))
        .orderBy(desc(dmCalls.createdAt), desc(dmCalls.id))
        .limit(1);
      return row ? toDmCall(row) : null;
    },

    /**
     * A user's cross-DM call history (Voice-UX #2), newest → oldest, keyset-paged
     * on `(createdAt, id)` — the SAME cursor shape as messages, so pages stay
     * disjoint and never duplicate a row even as new calls arrive between requests
     * (CLAUDE.md §22/§27). Returns ONLY attempts the user took part in (`caller`
     * OR `callee`), enforced in SQL — a user can never see a call between two
     * others. The `peer` is resolved by the join (the member that is NOT the
     * viewer), so the client renders a row without a follow-up user fetch.
     *
     * `before` is the opaque cursor from a previous page's `nextCursor`; a
     * missing/garbled cursor yields the first page (never an error page overlap).
     */
    async listRecentForUser(
      userId: UserId,
      options: { limit?: number; before?: string | null } = {},
    ): Promise<MessagesPage<RecentCall>> {
      const limit = Math.min(
        Math.max(options.limit ?? RECENT_CALLS_DEFAULT_LIMIT, 1),
        RECENT_CALLS_MAX_LIMIT,
      );
      const cursor = options.before ? decodeMessageCursor(options.before) : null;

      const conditions = [or(eq(dmCalls.callerId, userId), eq(dmCalls.calleeId, userId))];
      if (cursor) {
        // Strict keyset: the next page is everything ordered AFTER the cursor row
        // in newest-first order — identical predicate to messages pagination.
        conditions.push(
          sql`(${dmCalls.createdAt}, ${dmCalls.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
        );
      }

      // Join the peer = the participant that is NOT the viewer. The two arms are
      // mutually exclusive (a call's caller ≠ callee), so exactly one matches.
      const rows = await db
        .select({ call: dmCalls, peer: users })
        .from(dmCalls)
        .innerJoin(
          users,
          or(
            and(eq(dmCalls.callerId, userId), eq(users.id, dmCalls.calleeId)),
            and(eq(dmCalls.calleeId, userId), eq(users.id, dmCalls.callerId)),
          ),
        )
        .where(and(...conditions))
        .orderBy(desc(dmCalls.createdAt), desc(dmCalls.id))
        .limit(limit + 1);

      const items = rows.map(({ call, peer }) => toRecentCall(call, peer, userId));
      return buildMessagesPage(items, limit);
    },

    /**
     * Transition a call's status, optionally stamping `startedAt` (accept →
     * active) and/or `endedAt` (any terminal outcome). Clears `expiresAt` on any
     * move away from `ringing` so the emitted DTO matches its contract
     * (`expiresAt` is the ring deadline, null once no longer ringing —
     * @demli/types `DmCall`). Returns the updated row, or null if the call is
     * gone.
     */
    async setStatus(
      id: CallId,
      status: CallStatus,
      stamps?: { startedAt?: Date; endedAt?: Date },
    ): Promise<DmCall | null> {
      const set: Partial<typeof dmCalls.$inferInsert> = { status };
      if (status !== "ringing") set.expiresAt = null;
      if (stamps?.startedAt !== undefined) set.startedAt = stamps.startedAt;
      if (stamps?.endedAt !== undefined) set.endedAt = stamps.endedAt;
      const [row] = await db.update(dmCalls).set(set).where(eq(dmCalls.id, id)).returning();
      return row ? toDmCall(row) : null;
    },

    /**
     * Accept: `ringing → active` GUARDED ON THE CURRENT STATUS, in one statement.
     * Returns the updated row, or null when the call was no longer ringing (the
     * caller canceled, the ring was swept, another device already accepted).
     *
     * The guard is the mirror of {@link closeIfIn}'s and matters for the same
     * reason: an unconditional write here can resurrect a call that was canceled
     * microseconds earlier, producing an `active` row whose caller has already
     * torn down — a ghost call that blocks the DM until the sweeper reaps it.
     */
    async activateIfRinging(id: CallId, startedAt: Date): Promise<DmCall | null> {
      const [row] = await db
        .update(dmCalls)
        .set({ status: "active", startedAt, expiresAt: null })
        .where(and(eq(dmCalls.id, id), eq(dmCalls.status, "ringing")))
        .returning();
      return row ? toDmCall(row) : null;
    },

    /**
     * Terminal transition GUARDED ON THE CURRENT STATUS, in one statement:
     * `id` moves to `to` only if it is currently in `from`. Returns the updated
     * row, or null when it was not — meaning somebody else already moved it and
     * THIS caller must not act (no second system message, no second `call.ended`).
     *
     * Every terminal endpoint uses this instead of read-then-`setStatus`, because
     * read-then-write loses the accept race that is the whole subject of the
     * call-UX plan's K2: the callee accepts (`ringing → active`) in the window
     * between the caller's cancel handler reading `ringing` and writing
     * `canceled`, and the unconditional write then stamps `canceled` over a LIVE
     * call — the callee is sitting in a room whose row says the call never
     * happened. Guarding in SQL makes the database the arbiter: exactly one of
     * the two writers gets a row back.
     *
     * `expiresAt` is cleared (the ring deadline is meaningless once terminal),
     * matching {@link setStatus}'s contract.
     */
    async closeIfIn(
      id: CallId,
      from: readonly CallStatus[],
      to: CallStatus,
      endedAt: Date,
    ): Promise<DmCall | null> {
      if (from.length === 0) return null;
      const [row] = await db
        .update(dmCalls)
        .set({ status: to, endedAt, expiresAt: null })
        .where(and(eq(dmCalls.id, id), inArray(dmCalls.status, [...from])))
        .returning();
      return row ? toDmCall(row) : null;
    },

    /**
     * Every currently LIVE call (`ringing` | `active`), oldest first — the input
     * to the liveness sweep (`apps/api/src/lib/dm-call-sweeper.ts`). Oldest-first
     * so a backlog larger than {@link LIVE_CALLS_SWEEP_LIMIT} drains determinist-
     * ically (the oldest ghosts, which are the ones actually stuck, go first)
     * instead of starving behind fresh calls.
     */
    async listLive(limit: number = LIVE_CALLS_SWEEP_LIMIT): Promise<DmCall[]> {
      const rows = await db
        .select()
        .from(dmCalls)
        .where(inArray(dmCalls.status, [...LIVE_STATUSES]))
        .orderBy(dmCalls.createdAt, dmCalls.id)
        .limit(Math.max(1, limit));
      return rows.map(toDmCall);
    },

    /**
     * Close the given `ringing` rows whose ring deadline has passed → `missed`.
     *
     * The deadline is `COALESCE(expires_at, created_at + ringWindow)`: rows written
     * before the ring-deadline column was populated (or by any future path that
     * forgets it) would otherwise be UN-SWEEPABLE forever and keep blocking their
     * DM through the `dm_calls_one_live_per_dm` partial index. A ring can never
     * legitimately outlive its deadline — the accept endpoint itself refuses a late
     * accept — so this needs no liveness probe.
     *
     * SCOPED TO `ids` ON PURPOSE, even though the deadline predicate alone would
     * find the same rows — this pass must be BOUNDED. Unscoped, one tick flips every
     * expired ring in the table at once and then announces `call.ended` twice per
     * row: a backlog (a long outage, a first deploy against an old database) becomes
     * a single tick that writes thousands of rows and floods the realtime bus. The
     * caller has just read a LIMITED page of live rows, so naming them costs nothing
     * and turns the pass into "at most one page per tick", with the remainder picked
     * up by the next one.
     *
     * One conditional UPDATE … RETURNING, so concurrent API instances cannot both
     * "win" the same row: only the process whose UPDATE actually flipped the status
     * gets the row back, and therefore only it publishes the `call.ended` fan-out.
     * A row that starts ringing between the caller's read and this write is simply
     * caught by the next tick — it cannot be past its deadline yet anyway.
     */
    async expireRinging(
      ids: readonly CallId[],
      now: Date,
      ringWindowMs: number,
    ): Promise<DmCall[]> {
      if (ids.length === 0) return [];
      const rows = await db
        .update(dmCalls)
        .set({ status: "missed", endedAt: now, expiresAt: null })
        .where(
          and(
            inArray(dmCalls.id, [...ids]),
            eq(dmCalls.status, "ringing"),
            // Raw SQL, so every parameter carries its cast: the drizzle/postgres.js
            // bridge binds a bare Date/number as an untyped string and throws.
            sql`coalesce(${dmCalls.expiresAt}, ${dmCalls.createdAt} + make_interval(secs => ${ringWindowMs / 1000}::double precision)) < ${now.toISOString()}::timestamptz`,
          ),
        )
        .returning();
      return rows.map(toDmCall);
    },

    /**
     * Close the given `active` calls → `ended` (the media plane says nobody is in
     * the room). Guarded on `status = 'active'` so a call the participants ended
     * for real between the liveness probe and this write is never re-stamped, and
     * `RETURNING` again makes the flip the arbiter of who publishes.
     */
    async endAbandoned(ids: readonly CallId[], endedAt: Date): Promise<DmCall[]> {
      if (ids.length === 0) return [];
      const rows = await db
        .update(dmCalls)
        .set({ status: "ended", endedAt, expiresAt: null })
        .where(and(eq(dmCalls.status, "active"), inArray(dmCalls.id, [...ids])))
        .returning();
      return rows.map(toDmCall);
    },

    /**
     * Close every call this user is RINGING OUT on → `missed` (their last socket
     * dropped, so nobody is behind the ringback and the callee is ringing for a
     * caller that cannot answer). Deliberately caller-only: a callee losing its
     * WebSocket must NOT kill the ring, because a mobile callee is rung by PUSH
     * with no socket at all.
     *
     * `active` rows are untouched here — media lives on LiveKit, not on this
     * socket, so a dropped WebSocket is no evidence at all that a call ended
     * (see the sweeper for the media-plane-sourced criterion).
     */
    async missRingingByCaller(callerId: UserId, at: Date): Promise<DmCall[]> {
      const rows = await db
        .update(dmCalls)
        .set({ status: "missed", endedAt: at, expiresAt: null })
        .where(and(eq(dmCalls.status, "ringing"), eq(dmCalls.callerId, callerId)))
        .returning();
      return rows.map(toDmCall);
    },

    /**
     * Mark a call upgraded into a group: status → `upgraded`, link the group, and
     * stamp `endedAt` (the call LOG closes; media keeps flowing for the two
     * originals in the new group). Low-level primitive — the atomic group-creating
     * path is {@link callUpgradeRepo.upgradeDmToGroup}, which flips the call in the
     * SAME transaction. Returns the updated row, or null if the call is gone.
     */
    async markUpgraded(
      id: CallId,
      groupId: GroupId,
      endedAt: Date = new Date(),
    ): Promise<DmCall | null> {
      const [row] = await db
        .update(dmCalls)
        .set({ status: "upgraded", upgradedToGroupId: groupId, endedAt, expiresAt: null })
        .where(eq(dmCalls.id, id))
        .returning();
      return row ? toDmCall(row) : null;
    },
  };
}

export type CallsRepo = ReturnType<typeof callsRepo>;
