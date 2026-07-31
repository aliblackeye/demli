/**
 * Per-user playback volume control for mobile (kişi-başı ses seviyesi)
 * — the RN counterpart of desktop's `ParticipantVolumeMenu`. A LONG-PRESS on any
 * REMOTE participant (roster row or grid/stage tile) opens this bottom sheet with a
 * 0–200% volume slider + reset.
 *
 * The level is a LISTENER-side, client-only offset: `voice-store.setParticipantVolume`
 * write-through applies it live via the engine (which scales that remote's own native
 * playout, §10/§35 — no media over the WebSocket) and persists it. It composes with
 * deafen (a master mute): while deafened the slider is disabled and reads as inert;
 * undeafen restores the personal level. NEVER offered for the local user (you cannot
 * attenuate yourself) — surfaces guard on `isLocal` before opening.
 *
 * Trigger seam: {@link openParticipantVolumeSheet} is a MODULE-level function backed
 * by a tiny controller store, so any memoized tile/row triggers it on long-press
 * WITHOUT prop drilling (§27) — the sheet is mounted ONCE (in VoiceRoomScreen) and
 * resolves the target's live level/name from the voice store by identity.
 *
 * No native slider module (keeps OTA delivery to the installed APK intact): the
 * slider is built on RN core `PanResponder`, so the value genuinely reaches the
 * engine — not a dead button (§35).
 */
import { useEffect, useRef, useState } from "react";
import { Modal, PanResponder, Pressable, View } from "react-native";
import { Text } from "../ui/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { create } from "zustand";
import { RotateCcw, Volume1, Volume2, VolumeX } from "lucide-react-native";
import {
  DEFAULT_PARTICIPANT_VOLUME,
  isDefaultParticipantVolume,
  MAX_PARTICIPANT_VOLUME,
} from "@demli/media";
import type { UserId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { useVoiceStore } from "@/stores/voice-store";
import { colors, radius, space } from "@/theme/theme";

// ── controller store (which remote's sheet is open) ────────────────────────────
interface SheetController {
  /** Identity of the remote whose sheet is open, or null when closed. */
  targetId: string | null;
  open: (identity: string) => void;
  close: () => void;
}
const useSheetController = create<SheetController>((set) => ({
  targetId: null,
  open: (targetId) => set({ targetId }),
  close: () => set({ targetId: null }),
}));

/**
 * Open the per-user volume sheet for a REMOTE participant identity. Module-level so
 * any memoized tile/row can call it on long-press without threading a callback
 * (§27). Callers MUST guard on `!isLocal` first — you can't attenuate yourself.
 */
export function openParticipantVolumeSheet(identity: string): void {
  useSheetController.getState().open(identity);
}

// ── the 0..2 slider (PanResponder — no native module) ──────────────────────────
const THUMB = 22;
const TRACK_H = 6;

export function VolumeSlider({
  value,
  disabled,
  onStart,
  onChange,
  onEnd,
}: {
  /** Current level, 0..2. */
  value: number;
  disabled?: boolean;
  onStart?: () => void;
  onChange: (next: number) => void;
  onEnd?: () => void;
}) {
  const [width, setWidth] = useState(0);
  // Stable refs so the PanResponder is created ONCE — recreating it mid-gesture
  // would drop the active drag.
  const widthRef = useRef(0);
  widthRef.current = width;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const onStartRef = useRef(onStart);
  onStartRef.current = onStart;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  const emit = (locationX: number): void => {
    const w = widthRef.current;
    if (w <= 0) return;
    const ratio = Math.min(1, Math.max(0, locationX / w));
    onChangeRef.current(ratio * MAX_PARTICIPANT_VOLUME);
  };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !disabledRef.current,
      onMoveShouldSetPanResponder: () => !disabledRef.current,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        onStartRef.current?.();
        emit(e.nativeEvent.locationX);
      },
      onPanResponderMove: (e) => emit(e.nativeEvent.locationX),
      onPanResponderRelease: () => onEndRef.current?.(),
      onPanResponderTerminate: () => onEndRef.current?.(),
    }),
  ).current;

  const ratio = Math.min(1, Math.max(0, value / MAX_PARTICIPANT_VOLUME));
  const thumbLeft = Math.max(0, Math.min(width - THUMB, ratio * width - THUMB / 2));

  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      {...responder.panHandlers}
      accessible
      accessibilityRole="adjustable"
      accessibilityValue={{ min: 0, max: 200, now: Math.round(ratio * 200) }}
      hitSlop={{ top: 10, bottom: 10 }}
      style={{ height: THUMB + 10, justifyContent: "center" }}
    >
      {/* Visual layers are pointerEvents="none" so the outer View stays the touch
          target and locationX is always relative to it (no child-offset drift). */}
      {/* Track + filled portion. */}
      <View
        pointerEvents="none"
        style={{
          height: TRACK_H,
          borderRadius: TRACK_H / 2,
          backgroundColor: colors.surfaceRaised,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: ratio * width,
            backgroundColor: disabled ? colors.fgFaint : colors.accent,
          }}
        />
      </View>
      {/* 100% tick — the default marker. */}
      {width > 0 ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: width / 2 - 1,
            width: 2,
            height: TRACK_H + 8,
            borderRadius: 1,
            backgroundColor: colors.strokeStrong,
          }}
        />
      ) : null}
      {/* Thumb. */}
      {width > 0 ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: thumbLeft,
            width: THUMB,
            height: THUMB,
            borderRadius: THUMB / 2,
            backgroundColor: disabled ? colors.fgFaint : "#fff",
            borderWidth: 2,
            borderColor: disabled ? colors.stroke : colors.accent,
          }}
        />
      ) : null}
    </View>
  );
}

// ── the sheet ──────────────────────────────────────────────────────────────────
export function ParticipantVolumeSheet({
  nameFor,
}: {
  /** Resolve a display name from a userId (the roster-aware resolver from the screen). */
  nameFor: (userId: UserId) => string;
}) {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();

  const targetId = useSheetController((s) => s.targetId);
  const close = useSheetController((s) => s.close);
  const deafened = useVoiceStore((s) => s.deafened);
  const setParticipantVolume = useVoiceStore((s) => s.setParticipantVolume);
  // The live target from the engine's authoritative participant list (by identity).
  // Null when closed OR when the target left the room (auto-dismiss).
  const target = useVoiceStore((s) =>
    targetId ? s.participants.find((p) => p.identity === targetId) ?? null : null,
  );
  const remote = target && !target.isLocal ? target : null;

  // Fast local mirror so the thumb tracks the finger; re-sync from the engine's
  // authoritative level whenever it changes from elsewhere (reset, another surface)
  // — unless the user is mid-drag on this slider.
  const authoritative = remote?.volume ?? DEFAULT_PARTICIPANT_VOLUME;
  const [value, setValue] = useState(authoritative);
  const draggingRef = useRef(false);
  useEffect(() => {
    if (!draggingRef.current) setValue(authoritative);
  }, [authoritative, targetId]);

  const visible = remote != null;
  const name = remote ? nameFor(remote.userId) : "";
  const percent = Math.round(value * 100);
  const VolumeIcon = value <= 0 ? VolumeX : value < 1 ? Volume1 : Volume2;
  const atDefault = isDefaultParticipantVolume(value);

  const commit = (next: number): void => {
    if (!remote) return;
    setValue(next);
    setParticipantVolume(remote.userId, next);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <Pressable
        onPress={close}
        accessibilityLabel={t("common:buttons.close")}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}
      >
        {/* Card — its own Pressable swallows taps so they don't dismiss the sheet. */}
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: colors.surface,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            borderCurve: "continuous",
            borderTopWidth: 1,
            borderColor: colors.stroke,
            paddingTop: space.lg,
            paddingBottom: space.lg + insets.bottom,
            paddingHorizontal: space.lg,
            gap: space.sm,
          }}
        >
          {/* Header: name + live percentage. */}
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text variant="display"
              numberOfLines={1}
              style={{ flex: 1, color: colors.fg, fontSize: 16, fontWeight: "700" }}
            >
              {t("mobile:voice.userVolume.title")}
            </Text>
            <Text style={{ color: colors.fgMuted, fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
              {`${percent}%`}
            </Text>
          </View>
          <Text numberOfLines={1} style={{ color: colors.fgMuted, fontSize: 13 }}>
            {name}
          </Text>

          {/* Slider row. */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, marginTop: space.xs }}>
            <VolumeIcon size={20} color={colors.fgFaint} />
            <View style={{ flex: 1 }}>
              <VolumeSlider
                value={value}
                disabled={deafened}
                onStart={() => (draggingRef.current = true)}
                onChange={commit}
                onEnd={() => (draggingRef.current = false)}
              />
            </View>
          </View>

          {deafened ? (
            <Text style={{ color: colors.fgFaint, fontSize: 12 }}>
              {t("mobile:voice.userVolume.deafenedHint")}
            </Text>
          ) : null}

          <View style={{ height: 1, backgroundColor: colors.stroke, marginTop: space.xs }} />

          {/* Reset to 100% — disabled while deafened or already at default. */}
          <Pressable
            onPress={() => commit(DEFAULT_PARTICIPANT_VOLUME)}
            disabled={deafened || atDefault}
            accessibilityRole="button"
            accessibilityState={{ disabled: deafened || atDefault }}
            accessibilityLabel={t("mobile:voice.userVolume.reset")}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
              paddingVertical: space.md,
              paddingHorizontal: space.sm,
              borderRadius: radius.md,
              borderCurve: "continuous",
              opacity: deafened || atDefault ? 0.4 : 1,
              backgroundColor: pressed ? colors.surfaceRaised : "transparent",
            })}
          >
            <RotateCcw size={19} color={colors.fgMuted} />
            <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "600" }}>
              {t("mobile:voice.userVolume.reset")}
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
