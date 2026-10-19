import { useAppTranslation } from "../lib/i18n";
import { BlockedSendToast } from "./BlockedSendToast";
import { ImageActionToast } from "./ImageActionToast";
import { OutboxChannelGoneToast } from "./OutboxChannelGoneToast";
import { VoiceEvictionToast } from "./VoiceEvictionToast";

/**
 * The app-root NOTICE STACK — one bottom-centre column that owns the position
 * of every root notice, so two that fire together stack (newest nearest the
 * edge) instead of drawing on top of each other. Above the dialog/lightbox layer
 * (z-50) on purpose: an image saved from the lightbox must be confirmed while
 * the lightbox is still open. Each notice is the shared NoticeToast card and
 * owns its own timer.
 */
export function AppNoticeStack(): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <div
      role="region"
      aria-label={t("common:a11y.notifications")}
      className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex flex-col-reverse items-center gap-2 px-4"
    >
      {/* Single-active-session notice: shows "you joined voice on another
          device" when this device is evicted, and survives the voice panel
          unmounting. */}
      <VoiceEvictionToast />
      {/* Offline queue (M17): tells the user when queued messages had to be
          abandoned because their channel is gone — by definition there is no
          channel view left to show it in. */}
      <OutboxChannelGoneToast />
      {/* "Görsel kaydedildi / kopyalandı" (and the honest failure line) for the
          attachment save/copy actions. Root-level because the action can start
          from the full-screen lightbox, which unmounts on close. A CANCELLED
          save stays silent. */}
      <ImageActionToast />
      {/* Blocking (M18): a DM send the gateway refused because a block exists.
          Root-level for the same reason — the queue row can only show its
          generic "rejected" copy, so the neutral reason is given once, here. */}
      <BlockedSendToast />
    </div>
  );
}
