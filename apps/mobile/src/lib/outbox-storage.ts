/**
 * Mobile persistence for the offline send queue (M17) — the `OutboxStorage` seam
 * from `@demli/client-core`, and the mobile counterpart of the desktop
 * renderer's lib/outbox-storage.ts.
 *
 * Medium: a JSON file in the app's document directory via expo-file-system,
 * exactly like lib/draft-storage.ts. Two reasons this over the obvious
 * alternatives:
 *  - OTA safety (§32): expo-file-system is ALREADY in the shipped APK
 *    (attachments + the self-updater), so this adds no native module and stays
 *    deliverable over-the-air. `@react-native-async-storage/async-storage` would
 *    be a NEW native module and would break OTA for installed builds.
 *  - Size: a queue can hold up to `OUTBOX_MAX_ITEMS` messages, far past
 *    expo-secure-store's ~2 KB per-value cap. A plain file has no such limit.
 *
 * PER ACCOUNT. The filename carries the user id because a queue holds unsent
 * messages authored BY that user: one shared file would let account A's unsent
 * message drain out of account B's session (ADR 0013 store-reset rule).
 *
 * Every operation is best-effort and never throws — the in-memory queue stays
 * authoritative, and a storage failure must never lose a user's message.
 */

import { File, Paths } from "expo-file-system";
import type { OutboxStorage } from "@demli/client-core";
import type { UserId } from "@demli/types";

/** Keep the filename filesystem-safe whatever an id looks like. */
function safeId(userId: UserId): string {
  return userId.replace(/[^A-Za-z0-9_-]/g, "_");
}

function fileFor(userId: UserId): File {
  return new File(Paths.document, `demli-outbox.v1.${safeId(userId)}.json`);
}

/** An `OutboxStorage` bound to one account's file. */
export function createOutboxStorage(userId: UserId): OutboxStorage {
  return {
    get() {
      try {
        const file = fileFor(userId);
        if (!file.exists) return Promise.resolve(null);
        return Promise.resolve(file.textSync());
      } catch {
        return Promise.resolve(null);
      }
    },
    set(value) {
      try {
        const file = fileFor(userId);
        if (!file.exists) file.create();
        file.write(value);
      } catch {
        // Storage unavailable — the queue just won't survive a restart.
      }
      return Promise.resolve();
    },
    clear() {
      try {
        const file = fileFor(userId);
        if (file.exists) file.delete();
      } catch {
        // Best-effort, as everywhere else.
      }
      return Promise.resolve();
    },
  };
}
