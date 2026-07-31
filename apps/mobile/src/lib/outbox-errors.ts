/**
 * Localize an offline-queue failure reason (M17) — mobile twin of the desktop
 * renderer's lib/outbox-errors.ts.
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
      return t("mobile:message.queueOffline");
    case "timeout":
      return t("mobile:message.queueTimeout");
    case "rejected":
      return t("mobile:message.queueRejected");
    case "channel_gone":
      return t("mobile:message.queueChannelGone");
    case "attempts_exhausted":
      return t("mobile:message.queueExhausted");
    default:
      return t("mobile:message.failed");
  }
}
