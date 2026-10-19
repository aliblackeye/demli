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
 * WITHOUT prop drilling (§27) — the sheet is mounted ONCE (in VoiceStage) and
 * resolves the target's live level/name from the voice store by identity.
 *
 * Drawn by the kit: the draggable `ui/Sheet` (spring open, drag/flick to close)
 * and the `ui/Slider` (UI-thread drag, TalkBack adjustable, a tick at 100%), so
 * the value genuinely reaches the engine on every stepped change — not a dead
 * control (§35).
 */
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { create } from "zustand";
import { RotateCcw, Volume1, Volume2, VolumeX } from "lucide-react-native";
import {
  DEFAULT_PARTICIPANT_VOLUME,
  isDefaultParticipantVolume,
  MAX_PARTICIPANT_VOLUME,
} from "@demli/media";
import type { UserId } from "@demli/types";
import { Avatar } from "@/components/Avatar";
import { useAppTranslation } from "@/lib/i18n";
import { useChatStore } from "@/stores/chat-store";
import { useVoiceStore } from "@/stores/voice-store";
import { colors, space } from "@/theme/theme";
import { Button } from "../ui/Button";
import { Sheet } from "../ui/Sheet";
import { Slider } from "../ui/Slider";
import { Text } from "../ui/Text";

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

/** 5% steps: fine enough to balance two voices, coarse enough to land on 100%. */
const VOLUME_STEP = 0.05;

const formatPercent = (v: number): string => `${Math.round(v * 100)}%`;

// ── the sheet ──────────────────────────────────────────────────────────────────
export function ParticipantVolumeSheet({
  nameFor,
}: {
  /** Resolve a display name from a userId (the roster-aware resolver from the screen). */
  nameFor: (userId: UserId) => string;
}) {
  const { t } = useAppTranslation();

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
  const avatarUrl = useChatStore((s) => (remote ? s.users[remote.userId]?.avatarUrl ?? null : null));

  // Fast local mirror so the label tracks the finger; re-sync from the engine's
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
  const VolumeIcon = value <= 0 ? VolumeX : value < 1 ? Volume1 : Volume2;
  const atDefault = isDefaultParticipantVolume(value);

  const commit = (next: number): void => {
    if (!remote) return;
    setValue(next);
    setParticipantVolume(remote.userId, next);
  };

  return (
    <Sheet
      visible={visible}
      onClose={close}
      title={t("mobile:voice.userVolume.title")}
      footer={
        <Button
          variant="secondary"
          icon={RotateCcw}
          label={t("mobile:voice.userVolume.reset")}
          // Disabled while deafened or already at default — nothing to reset.
          disabled={deafened || atDefault}
          block
          onPress={() => commit(DEFAULT_PARTICIPANT_VOLUME)}
        />
      }
    >
      <View style={{ paddingHorizontal: space.xs, gap: space.md }}>
        {/* Whose voice this is — the face, not just a name, so a long-press on the
            wrong tile is obvious before the slider moves anything. */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          {remote ? <Avatar name={name} size="md" uri={avatarUrl} /> : null}
          <Text type="subheading" tone="default" numberOfLines={1} style={{ flex: 1 }}>
            {name}
          </Text>
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <VolumeIcon size={20} color={colors.fgMuted} strokeWidth={2} />
          <Slider
            value={value}
            min={0}
            max={MAX_PARTICIPANT_VOLUME}
            step={VOLUME_STEP}
            disabled={deafened}
            accessibilityLabel={t("mobile:voice.userVolume.open", { name })}
            formatValue={formatPercent}
            showValue
            marks={[DEFAULT_PARTICIPANT_VOLUME]}
            style={{ flex: 1 }}
            onValueChange={(next) => {
              draggingRef.current = true;
              commit(next);
            }}
            onSlidingComplete={() => {
              draggingRef.current = false;
            }}
          />
        </View>

        {deafened ? (
          <Text type="meta" tone="faint">
            {t("mobile:voice.userVolume.deafenedHint")}
          </Text>
        ) : null}
      </View>
    </Sheet>
  );
}
