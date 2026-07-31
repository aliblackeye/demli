import type {
  NotificationMuteMode,
  NotificationMuteScope,
  UserId,
} from "@demli/types";

/**
 * Notification-mute push filter (migration 0013).
 *
 * "Kanalı Sustur" / "Sunucuyu Sustur" applied to the OFFLINE push path: a
 * user who muted a channel (or its whole group/server) must not be pushed for
 * plain messages, and — in `"mentions"` mode — only for a direct `@mention`.
 * DM-call rings (`call.invite`) are NEVER routed through here, so a call always
 * rings regardless of any mute.
 *
 * This is the single, transport-agnostic gate the REST create path (apps/api)
 * and the WS gateway (apps/realtime) BOTH call right before `notifier.notify`,
 * so the two message paths cannot drift. It mirrors the package's other split
 * (a narrow store interface the DB repo satisfies + a pure decision), so a unit
 * test injects a stub with no database.
 */

/** One active (non-expired) mute row that bears on a message. */
export interface ActiveMuteRow {
  userId: UserId;
  scope: NotificationMuteScope;
  targetId: string;
  mode: NotificationMuteMode;
}

/**
 * Least-privilege slice of the notification-mutes repo the filter needs. The
 * DB `notificationMutesRepo` structurally satisfies this; a test stubs it with a
 * single method. `listActiveForRecipients` returns ONLY currently-active rows
 * (the repo applies the `until` expiry predicate), so the filter never re-checks
 * expiry.
 */
export interface NotificationMuteStore {
  listActiveForRecipients(input: {
    userIds: readonly UserId[];
    channelId?: string;
    groupId?: string;
    now?: Date;
  }): Promise<ActiveMuteRow[]>;
}

export interface MuteFilterContext {
  /** The channel the message landed in. */
  channelId: string;
  /** The group/server (or DM group) that channel belongs to. */
  groupId: string;
  /**
   * Whether this specific push is a direct `@mention` of the recipient. A
   * `"mentions"`-mode mute lets these through and silences everything else.
   * Group/server mention pushes pass `true`; a plain DM message passes `false`
   * (the caller computes it per recipient).
   */
  isMention: boolean;
  /** Expiry reference (default: now). Threaded to the store for deterministic tests. */
  now?: Date;
}

/**
 * The subset of `recipientIds` that should STILL receive a push, given each
 * recipient's active mutes on the message's channel/group.
 *
 * Precedence: a channel-scope mute overrides a group-scope mute for
 * that channel — the more specific setting wins. Effective mode →
 *  - none      → keep (not muted).
 *  - `"all"`   → drop.
 *  - `"mentions"` → keep only when `isMention`.
 *
 * Best-effort: a store failure logs and FAILS OPEN (returns the recipients
 * unfiltered) — an outage must never crash the already-persisted message's push
 * path, and over-notifying is a lesser evil than a thrown request. A missing
 * store (feature not wired) is a no-op passthrough.
 */
export async function filterMutedRecipients(
  store: NotificationMuteStore | undefined,
  recipientIds: readonly UserId[],
  ctx: MuteFilterContext,
  log: (message: string) => void = () => undefined,
): Promise<UserId[]> {
  if (!store || recipientIds.length === 0) return [...recipientIds];

  let rows: ActiveMuteRow[];
  try {
    rows = await store.listActiveForRecipients({
      userIds: recipientIds,
      channelId: ctx.channelId,
      groupId: ctx.groupId,
      now: ctx.now,
    });
  } catch (err) {
    log(`[push] mute filter failed (fail-open): ${err instanceof Error ? err.message : String(err)}`);
    return [...recipientIds];
  }

  if (rows.length === 0) return [...recipientIds];

  // Most-specific-wins: index channel-scope and group-scope modes per user.
  const channelMode = new Map<UserId, NotificationMuteMode>();
  const groupMode = new Map<UserId, NotificationMuteMode>();
  for (const row of rows) {
    if (row.scope === "channel" && row.targetId === ctx.channelId) {
      channelMode.set(row.userId, row.mode);
    } else if (row.scope === "group" && row.targetId === ctx.groupId) {
      groupMode.set(row.userId, row.mode);
    }
  }

  return recipientIds.filter((userId) => {
    const mode = channelMode.get(userId) ?? groupMode.get(userId);
    if (mode === undefined) return true; // not muted
    if (mode === "all") return false; // silence everything
    return ctx.isMention; // "mentions": only direct @mentions pass
  });
}
