import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, ScrollView, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AUDIO_BITRATE_PRESETS_KBPS,
  CHANNEL_NAME_MAX_LENGTH,
  isAudioBitratePreset,
} from "@demli/config";
import { PERMISSIONS } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import type { UpdateChannelInput } from "@demli/client-core";
import { Button } from "@/components/Button";
import { ChannelVisibilitySection } from "@/components/ChannelVisibilitySection";
import { ChipSelect } from "@/components/ChipSelect";
import { NsfwToggle } from "@/components/NsfwToggle";
import { TextField } from "@/components/TextField";
import { localizeError } from "@/lib/errors";
import { SLOWMODE_PRESETS, snapToPreset } from "@/lib/slowmode";
import { useGroupDetails, useServerPermissions } from "@/queries/chat-queries";
import { useDeleteChannel, useUpdateChannel } from "@/queries/management-queries";
import { colors, radius, space, typography } from "@/theme/theme";

/**
 * The bit-rate chips: "" = the media default, then the SHARED presets from
 * @demli/config — the same three steps desktop offers, from the same constant.
 *
 * This replaced a free numeric field plus a local copy of the 8…510 validation
 * bounds. Those bounds are the API's WIDE acceptance window, deliberately much
 * wider than what a user should be asked to choose from, and re-typing them here
 * meant mobile could drift from the server without anything noticing. A channel
 * saved before the preset UI can still hold any value in that window, which is
 * what {@link CUSTOM_BITRATE_KEY} is for.
 */
const DEFAULT_BITRATE_KEY = "";
/**
 * Shown ONLY when the stored value is not one of the presets, so opening this
 * screen never silently snaps a legacy channel to a different bit rate (desktop
 * does the same). Selecting another chip is what changes it.
 */
const CUSTOM_BITRATE_KEY = "custom";

/** i18n key per preset — `satisfies` keeps this exhaustive if the presets change. */
const BITRATE_LABEL_KEY = {
  8: "mobile:channelSettings.bitrateLow",
  64: "mobile:channelSettings.bitrateNormal",
  128: "mobile:channelSettings.bitrateHigh",
} as const satisfies Record<(typeof AUDIO_BITRATE_PRESETS_KBPS)[number], string>;

function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      style={{
        color: colors.fgFaint,
        fontSize: typography.size["2xs"],
        fontWeight: "700",
        letterSpacing: 0.6,
        textTransform: "uppercase",
      }}
    >
      {children}
    </Text>
  );
}

/**
 * Owner-only channel management: edit name + description, plus a voice-only max
 * participants cap, or delete the channel. Current values are read from the
 * server's details cache. Presented as a modal from the server screen.
 */
export default function ChannelSettings() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{ channelId: string; groupId: string }>();
  const channelId = params.channelId ?? null;
  const groupId = params.groupId ?? null;
  const insets = useSafeAreaInsets();

  // Slow-mode presets: only the "0 = off" label is language-dependent; the rest
  // are unit-based (5s, 1m, …) and stay verbatim.
  const slowmodeChipOptions = SLOWMODE_PRESETS.map((p) => ({
    key: String(p.value),
    label: p.value === 0 ? t("mobile:slowmode.off") : p.label,
  }));

  const { data, isLoading } = useGroupDetails(groupId);
  const { isOwner, can } = useServerPermissions(groupId);
  const canManageChannels = isOwner || can(PERMISSIONS.MANAGE_CHANNELS);
  const channel = data?.channels.find((c) => c.id === channelId) ?? null;
  const isVoice = channel?.kind === "voice";

  const updateChannel = useUpdateChannel(groupId);
  const deleteChannel = useDeleteChannel(groupId);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [maxParticipants, setMaxParticipants] = useState("");
  const [slowmodeSeconds, setSlowmodeSeconds] = useState(0);
  const [audioBitrate, setAudioBitrate] = useState("");
  const [nsfw, setNsfw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (channel && !hydrated) {
      setName(channel.name);
      setDescription(channel.description ?? "");
      setMaxParticipants(
        channel.maxParticipants != null ? String(channel.maxParticipants) : "",
      );
      setSlowmodeSeconds(snapToPreset(channel.slowmodeSeconds ?? 0));
      // A stored value that is not one of the offered presets selects the
      // read-only "custom" chip rather than being snapped to a nearby preset.
      setAudioBitrate(
        channel.audioBitrateKbps == null
          ? DEFAULT_BITRATE_KEY
          : isAudioBitratePreset(channel.audioBitrateKbps)
            ? String(channel.audioBitrateKbps)
            : CUSTOM_BITRATE_KEY,
      );
      setNsfw(channel.nsfw ?? false);
      setHydrated(true);
    }
  }, [channel, hydrated]);

  /**
   * Default + the three shared presets, plus a "custom" chip ONLY while the
   * channel actually holds an off-preset value (a channel configured before this
   * UI existed). Appending it conditionally is what lets the screen show the
   * truth without offering "custom" as something a user can pick.
   */
  const bitrateChipOptions = [
    { key: DEFAULT_BITRATE_KEY, label: t("mobile:channelSettings.bitrateDefault") },
    ...AUDIO_BITRATE_PRESETS_KBPS.map((kbps) => ({
      key: String(kbps),
      label: `${t(BITRATE_LABEL_KEY[kbps])} · ${kbps}`,
    })),
    ...(audioBitrate === CUSTOM_BITRATE_KEY
      ? [
          {
            key: CUSTOM_BITRATE_KEY,
            label: `${t("mobile:channelSettings.bitrateCustom")} · ${channel?.audioBitrateKbps ?? ""}`,
          },
        ]
      : []),
  ];

  const onSave = () => {
    if (!channelId) return;
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > CHANNEL_NAME_MAX_LENGTH) {
      setError(t("mobile:channelSettings.validationName", { max: CHANNEL_NAME_MAX_LENGTH }));
      return;
    }

    const input: UpdateChannelInput = {
      name: trimmed,
      description: description.trim() || null,
    };

    if (isVoice) {
      const raw = maxParticipants.trim();
      if (raw.length > 0) {
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1) {
          setError(t("mobile:channelSettings.validationMaxParticipants"));
          return;
        }
        input.maxParticipants = parsed;
      } else {
        input.maxParticipants = null; // cleared = no limit
      }

      // The chips can only produce a preset, the untouched custom value, or the
      // default — all already valid — so there is nothing left to validate here.
      input.audioBitrateKbps =
        audioBitrate === DEFAULT_BITRATE_KEY
          ? null // default chip = clear it, media default applies
          : audioBitrate === CUSTOM_BITRATE_KEY
            ? (channel?.audioBitrateKbps ?? null) // untouched legacy value
            : Number(audioBitrate);
    } else {
      // NSFW is text-only (the API rejects it on voice).
      input.nsfw = nsfw;
    }

    // Slowmode follows the CHAT, not the kind (M20): every voice channel now has
    // a text chat, and a busy room's chat is exactly where a spam burst lands.
    // The API has accepted it on both kinds since the backend wave, and the
    // limiter is shared by channel id across REST and WS. Deliberately OUTSIDE
    // the kind branch above, so there is one field, not a copy per arm.
    input.slowmodeSeconds = slowmodeSeconds;

    setError(null);
    updateChannel.mutate(
      { channelId, input },
      {
        onSuccess: () => router.back(),
        onError: (err) => setError(localizeError(err, t)),
      },
    );
  };

  const onDelete = () => {
    if (!channelId) return;
    Alert.alert(
      t("mobile:channelSettings.deleteConfirmTitle"),
      t("mobile:channelSettings.deleteConfirmBody", {
        name: channel?.name ?? t("mobile:channelSettings.deleteConfirmFallbackName"),
      }),
      [
        { text: t("buttons.cancel"), style: "cancel" },
        {
          text: t("buttons.delete"),
          style: "destructive",
          onPress: () =>
            deleteChannel.mutate(channelId, {
              onSuccess: () => router.back(),
              onError: (err) =>
                Alert.alert(t("mobile:channelSettings.deleteError"), localizeError(err, t)),
            }),
        },
      ],
    );
  };

  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={{ flex: 1, backgroundColor: colors.app }}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.app }}
        contentContainerStyle={{
          padding: space.lg,
          paddingBottom: space.xl + insets.bottom,
          gap: space.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Stack.Screen
          options={{
            title: isVoice
              ? t("mobile:channelSettings.voiceTitle")
              : t("mobile:channelSettings.title"),
          }}
        />

        {isLoading && !channel ? (
          <View style={{ paddingTop: space.xl, alignItems: "center" }}>
            <ActivityIndicator color={colors.fgFaint} />
          </View>
        ) : null}

        {!isLoading && !channel ? (
          <Text style={{ color: colors.fgMuted, fontSize: 14, textAlign: "center", paddingTop: space.xl }}>
            {t("mobile:channelSettings.notFound")}
          </Text>
        ) : null}

        {channel ? (
          <>
            {error ? (
              <View style={{ backgroundColor: colors.dangerSurface, borderRadius: radius.sm, padding: space.sm }}>
                <Text selectable style={{ color: colors.danger, fontSize: 13 }}>
                  {error}
                </Text>
              </View>
            ) : null}

            <View style={{ gap: space.md }}>
              <TextField
                label={t("mobile:channelSettings.nameLabel")}
                value={name}
                onChangeText={setName}
                maxLength={CHANNEL_NAME_MAX_LENGTH}
                placeholder={t("mobile:channelSettings.namePlaceholder")}
                autoCapitalize="none"
              />
              <TextField
                label={t("mobile:channelSettings.descriptionLabel")}
                value={description}
                onChangeText={setDescription}
                placeholder={t("mobile:channelSettings.descriptionPlaceholder")}
                multiline
                style={{ minHeight: 72, textAlignVertical: "top" }}
              />
              {isVoice ? (
                <>
                  <TextField
                    label={t("mobile:channelSettings.maxParticipantsLabel")}
                    value={maxParticipants}
                    onChangeText={setMaxParticipants}
                    keyboardType="number-pad"
                    placeholder={t("mobile:channelSettings.maxParticipantsPlaceholder")}
                    hint={t("mobile:channelSettings.maxParticipantsHint")}
                  />
                  <View style={{ gap: space.sm }}>
                    <Text style={{ color: colors.fgMuted, fontSize: 13, fontWeight: "600" }}>
                      {t("mobile:channelSettings.bitrateLabel")}
                    </Text>
                    <ChipSelect
                      options={bitrateChipOptions}
                      selectedKey={audioBitrate}
                      onSelect={setAudioBitrate}
                    />
                    <Text style={{ color: colors.fgFaint, fontSize: 12 }}>
                      {t("mobile:channelSettings.bitrateHint")}
                    </Text>
                  </View>
                </>
              ) : null}
              {/* Slow mode is offered on BOTH kinds (M20) — it throttles the
                  CHAT, and every voice channel now has one. Hiding it on voice
                  was the last client-side reason a voice channel's conversation
                  was a second-class one. Outside the kind branch above on
                  purpose: one field, not a copy per arm. */}
              <View style={{ gap: space.sm }}>
                <Text style={{ color: colors.fgMuted, fontSize: 13, fontWeight: "600" }}>
                  {t("mobile:channelSettings.slowmode")}
                </Text>
                <ChipSelect
                  options={slowmodeChipOptions}
                  selectedKey={String(slowmodeSeconds)}
                  onSelect={(key) => setSlowmodeSeconds(Number(key))}
                />
                <Text style={{ color: colors.fgFaint, fontSize: 12 }}>
                  {isVoice
                    ? t("mobile:channelSettings.slowmodeVoiceHint")
                    : t("mobile:channelSettings.slowmodeHint")}
                </Text>
              </View>
              {!isVoice ? <NsfwToggle value={nsfw} onChange={setNsfw} /> : null}
              <Button label={t("mobile:common.saveChanges")} onPress={onSave} loading={updateChannel.isPending} />
            </View>

            {canManageChannels && channelId && groupId ? (
              <ChannelVisibilitySection groupId={groupId} channelId={channelId} />
            ) : null}

            <View style={{ height: 1, backgroundColor: colors.stroke }} />

            <View style={{ gap: space.md }}>
              <SectionLabel>{t("mobile:common.dangerZone")}</SectionLabel>
              <Button
                label={t("mobile:channelSettings.delete")}
                variant="danger"
                onPress={onDelete}
                loading={deleteChannel.isPending}
                style={{ borderRadius: radius.md }}
              />
            </View>
          </>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
