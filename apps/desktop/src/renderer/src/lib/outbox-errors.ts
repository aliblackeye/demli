/**
 * Localize an offline-queue failure reason (M17).
 *
 * The queue stores a KEY, never a sentence (ADR 0009 / client-core is i18n-free),
 * so the message is resolved here at render — which is what makes a live locale
 * switch re-label a message that is still sitting in the queue.
 */

import type { OutboxErrorKey } from "@demli/client-core";
import type { AppTFunction } from "./i18n";

export function outboxErrorText(key: OutboxErrorKey | null, t: AppTFunction): string {
  switch (key) {
    case "offline":
      return t("desktop:chat.queueOffline");
    case "timeout":
      return t("desktop:chat.queueTimeout");
    case "rejected":
      return t("desktop:chat.queueRejected");
    case "channel_gone":
      return t("desktop:chat.queueChannelGone");
    case "attempts_exhausted":
      return t("desktop:chat.queueExhausted");
    default:
      return t("desktop:chat.sendFailed");
  }
}
