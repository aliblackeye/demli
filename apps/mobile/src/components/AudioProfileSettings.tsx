import { useState } from "react";
import { Platform, View } from "react-native";
import { Text } from "./ui/Text";
import { useAppTranslation } from "@/lib/i18n";
import { ChipSelect } from "@/components/ChipSelect";
import { HeadphonesConfirm } from "@/components/HeadphonesConfirm";
import { useMediaSettings } from "@/stores/media-settings";
import { useVoiceStore } from "@/stores/voice-store";
import { colors, space, typography } from "@/theme/theme";

/**
 * "Ses profili" (task #121) — which Android audio stream the room's REMOTE audio
 * plays on: the call stream (Görüşme, default) or the media stream (Medya).
 *
 * WebRTC mixes every remote sound — each participant's mic AND a desktop host's
 * shared film/system audio — into ONE playout track, so this single choice
 * governs both. The tradeoff is real in both directions (media volume + no speech
 * DSP + A2DP, versus hardware echo cancellation + reliable Bluetooth mic), so the
 * description under each option states the downside rather than selling it. See
 * media/audio-profile.ts for the full reasoning.
 *
 * ANDROID ONLY: the setting maps to `AndroidAudioTypeOptions`, which the iOS audio
 * session ignores — so the section is not rendered there (no dead control, §35).
 *
 * Changing this NEVER disturbs a live session: `AudioSession.configureAudio` is
 * only honoured before `Room.connect()`, and we deliberately do not force a
 * rejoin. While the user is in a room the hint says the choice lands on the next
 * connect.
 *
 * Medya can switch the phone's hardware echo canceller off, so picking it opens the
 * same headphones confirmation as turning Yankı Engelleme off; only the confirm
 * button changes the profile.
 */

function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      style={{
        color: colors.fgFaint,
        fontSize: typography.size["2xs"],
        fontWeight: "700",
        letterSpacing: 0.6,
        textTransform: "uppercase",
        paddingHorizontal: space.lg,
        paddingTop: space.lg,
        paddingBottom: space.xs,
      }}
    >
      {children}
    </Text>
  );
}

export function AudioProfileSettings() {
  const { t } = useAppTranslation();
  const audioProfile = useMediaSettings((s) => s.audioProfile);
  const setAudioProfile = useMediaSettings((s) => s.setAudioProfile);
  const [confirmingMedia, setConfirmingMedia] = useState(false);

  // Same "am I in a room" read MicSettings uses. The DM-call controller drives the
  // SAME engine, so this covers calls as well as voice channels.
  const status = useVoiceStore((s) => s.status);
  const inRoom = status === "connected" || status === "joining" || status === "reconnecting";

  if (Platform.OS !== "android") return null;

  return (
    <View>
      <SectionLabel>{t("mobile:audioProfile.section")}</SectionLabel>

      <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
        <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "600" }}>
          {t("mobile:audioProfile.label")}
        </Text>
        <ChipSelect
          options={[
            { key: "communication", label: t("mobile:audioProfile.optionCall") },
            { key: "media", label: t("mobile:audioProfile.optionMedia") },
          ]}
          selectedKey={audioProfile}
          onSelect={(key) => {
            if (key === "media") {
              if (audioProfile !== "media") setConfirmingMedia(true);
            } else {
              setConfirmingMedia(false);
              setAudioProfile("communication");
            }
          }}
        />
      </View>

      {confirmingMedia && audioProfile !== "media" ? (
        <View style={{ paddingHorizontal: space.sm, paddingTop: space.sm }}>
          <HeadphonesConfirm
            message={t("mobile:audioProfile.mediaWarning")}
            confirmLabel={t("mobile:audioProfile.mediaConfirm")}
            cancelLabel={t("mobile:audioProfile.mediaCancel")}
            onCancel={() => setConfirmingMedia(false)}
            onConfirm={() => {
              setAudioProfile("media_headphones");
              setConfirmingMedia(false);
            }}
          />
        </View>
      ) : null}

      <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.sm }}>
        <Text style={{ color: colors.fgMuted, fontSize: 12, lineHeight: 17 }}>
          {audioProfile === "media"
            ? t("mobile:audioProfile.mediaDesc")
            : t("mobile:audioProfile.callDesc")}
        </Text>

        <Text style={{ color: colors.fgFaint, fontSize: 12 }}>
          {inRoom
            ? t("mobile:audioProfile.activeHint")
            : t("mobile:audioProfile.applyNote")}
        </Text>
      </View>
    </View>
  );
}
