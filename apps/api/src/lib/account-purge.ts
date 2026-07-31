/**
 * Account purge job (M15) — the periodic backstop that anonymizes soft-deleted
 * accounts whose 14-day freeze window has elapsed. Mirrors the attachment orphan
 * sweep ({@link ../modules/attachments/index.startAttachmentSweep}): started at
 * boot in the long-running server, cleared on graceful shutdown, `unref`'d so it
 * never keeps the process alive on its own, and each tick fully guarded so a
 * failure is logged, never thrown.
 *
 * The actual scrub lives in `usersRepo.purgeExpired` (which documents WHY it
 * anonymizes rather than hard-deletes: `messages.author_id` / `friend_groups.
 * owner_id` RESTRICT). This module only owns the schedule.
 */

import type { Repositories } from "@demli/db";

export interface AccountPurgeOptions {
  repos: Repositories;
  /** How often to run (ms). Default 1 hour. */
  intervalMs?: number;
  log?: (message: string) => void;
}

/** One hour. */
const DEFAULT_PURGE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Start the periodic account-purge job. Returns a stop function that clears the
 * timer.
 */
export function startAccountPurge(options: AccountPurgeOptions): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_PURGE_INTERVAL_MS;
  const log = options.log ?? (() => {});

  const tick = async (): Promise<void> => {
    try {
      const purged = await options.repos.users.purgeExpired(new Date());
      if (purged > 0) log(`account purge: anonymized ${purged} expired account(s)`);
    } catch (err) {
      log(`account purge: failed: ${String(err)}`);
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
