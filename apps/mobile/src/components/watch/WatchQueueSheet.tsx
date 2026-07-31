/**
 * The Watch Party queue on the phone — what is playing now, what comes next, and
 * how loud the film is (M20 mobile parity).
 *
 * The RN twin of `packages/app-ui/src/components/WatchQueuePanel.tsx`. On desktop
 * the queue is a column beside a 16:9 video, because a laptop has width to spare.
 * A phone does not: the same column next to a portrait video would leave both
 * unreadable. So it is a bottom sheet — summoned, read, dismissed — which is also
 * the only shape that can carry the film-volume control comfortably.
 *
 * ## The host / viewer split, unchanged
 *
 * Everyone in the room SEES the queue: it is the answer to "what are we watching
 * after this?", which a viewer asks as much as a host. Nobody but the host (or the
 * server owner, the same override the player honours) gets a mutation control, and
 * a viewer gets no disabled twins of them — §35 forbids a button that looks
 * pressable and does nothing, and the gateway would refuse the frame with
 * `NOT_HOST` anyway. The absence IS the message.
 *
 * ## Reordering is buttons, not dragging
 *
 * The desktop panel offers drag-and-drop AND move buttons; the buttons exist there
 * because HTML5 drag events do not survive a touch screen. Here only the buttons
 * remain, which is the same decision arriving at its natural conclusion rather
 * than a reduction: they are ≥44pt targets, they are omitted at the ends instead
 * of disabled, and they feed the same full-order `onReorder` the desktop sends.
 *
 * ## Film volume is a mobile-only control, and it is not a mistake that it is here
 *
 * On a laptop the film's loudness is an OS mixer problem the user already knows
 * how to solve. A phone has one volume rocker and the voice call owns it. This
 * control moves the EMBED's volume only — it never touches the audio session that
 * `media/audio-profile.ts` configured for the call (see WatchPartyPlayer's header
 * for why that is off limits), so turning the film down to hear a friend cannot
 * break echo cancellation or Bluetooth mic capture.
 *
 * ## Titles are text
 *
 * `title` comes from YouTube by way of another user's search. It is rendered as an
 * RN `<Text>` child and never as markdown, a link, or anything that could become
 * markup. A queued row is not a place where somebody else's string gets to be
 * anything but a string.
 */

import { memo } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowDown, ArrowUp, ListVideo, Play, Plus, Trash2, Volume2 } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { haptics } from "@/lib/haptics";
import { ChipSelect } from "@/components/ChipSelect";
import { colors, radius, space } from "@/theme/theme";
import { Text } from "../ui/Text";
import { canMoveQueueItem, formatWatchDuration, moveQueueItem } from "./watch-queue";

/**
 * The film-volume steps offered.
 *
 * Discrete rather than a slider on purpose: a continuous control would mean a new
 * dependency (`@react-native-community/slider` is not in this app) for a value
 * nobody tunes to the percent. Four steps cover the whole intent — full, quieter
 * than the conversation, background, and off — and each one is a ≥40pt target.
 */
export const WATCH_VOLUME_STEPS = [100, 60, 30, 0] as const;

/** Default film volume: the video as its author mixed it. */
export const DEFAULT_WATCH_VOLUME = 100;

/** One queued video, already joined to a display name for whoever added it. */
export interface WatchQueueEntry {
  itemId: string;
  videoId: string;
  /** Untrusted display text. Null when the adder supplied none (a raw link). */
  title: string | null;
  durationSeconds: number | null;
  /** Resolved display name of the adder — the caller owns the user lookup. */
  addedByName: string;
}

export interface WatchQueueSheetProps {
  visible: boolean;
  onClose: () => void;
  /** The queue, in play order. Does NOT include the video playing right now. */
  items: readonly WatchQueueEntry[];
  /** What the room is watching at this moment, for the sheet's top row. */
  nowPlaying: { videoId: string; title: string | null } | null;
  /**
   * Host, or the server owner override. Gates whether ANY mutation control is
   * rendered — cosmetic, exactly like every other client-side permission check,
   * and the gateway re-decides every frame.
   */
  canControl: boolean;
  /** Jump straight to this item (`watch.queue_play`). */
  onPlayNow: (itemId: string) => void;
  /** Drop this item (`watch.queue_remove`). */
  onRemove: (itemId: string) => void;
  /**
   * The FULL desired order (`watch.queue_reorder`). The server takes a complete
   * list rather than a delta, so a reorder computed from a slightly stale view
   * converges instead of corrupting.
   */
  onReorder: (itemIds: string[]) => void;
  /** Open the picker (`watch.queue_add` happens after a video is chosen). */
  onAdd: () => void;
  /** Film volume 0–100, applied to the embed only. */
  volumePercent: number;
  onVolumeChange: (volumePercent: number) => void;
}

/** A ≥44pt icon control for a queue row. */
function RowButton({
  Icon,
  label,
  danger,
  onPress,
}: {
  Icon: typeof Play;
  label: string;
  danger?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={() => {
        haptics.light();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: radius.sm,
        borderCurve: "continuous",
        backgroundColor: pressed ? colors.surfaceRaised : "transparent",
      })}
    >
      <Icon size={18} color={danger ? colors.danger : colors.fgMuted} />
    </Pressable>
  );
}

function WatchQueueSheetImpl({
  visible,
  onClose,
  items,
  nowPlaying,
  canControl,
  onPlayNow,
  onRemove,
  onReorder,
  onAdd,
  volumePercent,
  onVolumeChange,
}: WatchQueueSheetProps) {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();

  const ids = items.map((item) => item.itemId);

  const move = (itemId: string, delta: -1 | 1): void => {
    if (!canMoveQueueItem(ids, itemId, delta)) return;
    onReorder(moveQueueItem(ids, itemId, delta));
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        accessibilityLabel={t("common:buttons.close")}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" }}
      >
        <Pressable
          onPress={() => {}}
          accessibilityLabel={t("mobile:watchParty.queueTitle")}
          style={{
            maxHeight: "82%",
            backgroundColor: colors.surface,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            borderCurve: "continuous",
            borderTopWidth: 1,
            borderColor: colors.stroke,
            paddingTop: space.md,
            paddingBottom: space.md + insets.bottom,
            paddingHorizontal: space.lg,
            gap: space.md,
          }}
        >
          {/* Grab handle. */}
          <View
            style={{
              alignSelf: "center",
              width: 36,
              height: 4,
              borderRadius: radius.pill,
              backgroundColor: colors.strokeStrong,
            }}
          />

          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <ListVideo size={18} color={colors.accent} />
            <Text
              variant="display"
              style={{ flex: 1, color: colors.fg, fontSize: 17, fontWeight: "800" }}
            >
              {t("mobile:watchParty.queueTitle")}
            </Text>
            <View
              style={{
                paddingHorizontal: space.sm,
                paddingVertical: 2,
                borderRadius: radius.pill,
                backgroundColor: colors.surfaceRaised,
              }}
            >
              <Text style={{ color: colors.fgMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>
                {String(items.length)}
              </Text>
            </View>
            {/* Adding is host-only. A viewer gets no disabled twin of this. */}
            {canControl ? (
              <RowButton
                Icon={Plus}
                label={t("mobile:watchParty.queueAdd")}
                onPress={onAdd}
              />
            ) : null}
          </View>

          {nowPlaying !== null ? (
            <View
              style={{
                borderRadius: radius.md,
                borderCurve: "continuous",
                borderWidth: 1,
                borderColor: colors.accent,
                backgroundColor: colors.accentSurface,
                paddingHorizontal: space.md,
                paddingVertical: space.sm,
                gap: 2,
              }}
            >
              <Text
                style={{
                  color: colors.accent,
                  fontSize: 11,
                  fontWeight: "700",
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                }}
              >
                {t("mobile:watchParty.queueNowPlaying")}
              </Text>
              <Text numberOfLines={2} style={{ color: colors.fg, fontSize: 13, lineHeight: 18 }}>
                {nowPlaying.title ?? t("mobile:watchParty.queueUntitled")}
              </Text>
            </View>
          ) : null}

          {/* Film volume — everyone's own, never broadcast, never the audio
              session. See this file's header. */}
          <View style={{ gap: space.sm }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Volume2 size={16} color={colors.fgMuted} />
              <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "600" }}>
                {t("mobile:watchParty.filmVolume")}
              </Text>
            </View>
            <ChipSelect
              options={WATCH_VOLUME_STEPS.map((step) => ({
                key: String(step),
                label:
                  step === 0 ? t("mobile:watchParty.filmVolumeMuted") : `${String(step)}%`,
              }))}
              selectedKey={String(volumePercent)}
              onSelect={(key) => onVolumeChange(Number(key))}
            />
            <Text style={{ color: colors.fgFaint, fontSize: 11, lineHeight: 16 }}>
              {t("mobile:watchParty.filmVolumeHint")}
            </Text>
          </View>

          {items.length === 0 ? (
            <View style={{ alignItems: "center", gap: space.sm, paddingVertical: space.xl }}>
              <ListVideo size={26} color={colors.fgFaint} />
              <Text
                style={{
                  color: colors.fgMuted,
                  fontSize: 12,
                  lineHeight: 17,
                  textAlign: "center",
                }}
              >
                {canControl
                  ? t("mobile:watchParty.queueEmptyHost")
                  : t("mobile:watchParty.queueEmptyViewer")}
              </Text>
            </View>
          ) : (
            <ScrollView
              style={{ flexGrow: 0 }}
              contentContainerStyle={{ gap: space.xs, paddingBottom: space.sm }}
            >
              {items.map((item, index) => {
                const duration = formatWatchDuration(item.durationSeconds);
                const title = item.title ?? t("mobile:watchParty.queueUntitled");
                return (
                  <View
                    key={item.itemId}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: space.sm,
                      borderRadius: radius.md,
                      borderCurve: "continuous",
                      backgroundColor: colors.surfaceRaised,
                      paddingHorizontal: space.sm,
                      paddingVertical: space.sm,
                    }}
                  >
                    <Text
                      style={{
                        width: 18,
                        textAlign: "right",
                        color: colors.fgFaint,
                        fontSize: 11,
                        fontVariant: ["tabular-nums"],
                      }}
                    >
                      {String(index + 1)}
                    </Text>

                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <Text
                        numberOfLines={2}
                        style={{ color: colors.fg, fontSize: 13, lineHeight: 18 }}
                      >
                        {title}
                      </Text>
                      <Text numberOfLines={1} style={{ color: colors.fgFaint, fontSize: 11 }}>
                        {duration === null
                          ? t("mobile:watchParty.queueAddedBy", { name: item.addedByName })
                          : `${duration} · ${t("mobile:watchParty.queueAddedBy", {
                              name: item.addedByName,
                            })}`}
                      </Text>
                    </View>

                    {/* Host-only controls, omitted at the ends rather than
                        disabled — a viewer sees none of this column at all. */}
                    {canControl ? (
                      <View style={{ flexDirection: "row", alignItems: "center" }}>
                        {canMoveQueueItem(ids, item.itemId, -1) ? (
                          <RowButton
                            Icon={ArrowUp}
                            label={t("mobile:watchParty.queueMoveUp", { title })}
                            onPress={() => move(item.itemId, -1)}
                          />
                        ) : null}
                        {canMoveQueueItem(ids, item.itemId, 1) ? (
                          <RowButton
                            Icon={ArrowDown}
                            label={t("mobile:watchParty.queueMoveDown", { title })}
                            onPress={() => move(item.itemId, 1)}
                          />
                        ) : null}
                        <RowButton
                          Icon={Play}
                          label={t("mobile:watchParty.queuePlayNow", { title })}
                          onPress={() => onPlayNow(item.itemId)}
                        />
                        <RowButton
                          Icon={Trash2}
                          danger
                          label={t("mobile:watchParty.queueRemove", { title })}
                          onPress={() => onRemove(item.itemId)}
                        />
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * Memoized (§27): the sheet lives next to a player whose parent re-renders on
 * every 5 s heartbeat and on every presence tick, and none of that changes the
 * queue. With a stable `items` reference from the store it re-renders on a real
 * `watch.queue_updated` frame and on nothing else.
 */
export const WatchQueueSheet = memo(WatchQueueSheetImpl);
