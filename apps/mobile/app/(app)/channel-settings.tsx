import { useEffect, useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Hash, Save, Trash2 } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AUDIO_BITRATE_PRESETS_KBPS,
  CHANNEL_NAME_MAX_LENGTH,
  isAudioBitratePreset,
} from "@demli/config";
import { PERMISSIONS } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import type { UpdateChannelInput } from "@demli/client-core";
import { ChannelVisibilitySection } from "@/components/ChannelVisibilitySection";
import { ChipSelect } from "@/components/ChipSelect";
import { EmptyState } from "@/components/EmptyState";
import { NsfwToggle } from "@/components/NsfwToggle";
import { Skeleton } from "@/components/Skeleton";
import { TextField } from "@/components/TextField";
import { ConfirmSheet } from "@/components/settings/ConfirmSheet";
import { LoadErrorState } from "@/components/settings/LoadErrorState";
import { DangerZone, SectionEyebrow } from "@/components/settings/SettingsSection";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Text } from "@/components/ui/Text";
import { localizeError } from "@/lib/errors";
import { resolveEntityLoadState } from "@/lib/load-state";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import { SLOWMODE_PRESETS, snapToPreset } from "@/lib/slowmode";
import { useGroupDetails, useServerPermissions } from "@/queries/chat-queries";
import { useDeleteChannel, useUpdateChannel } from "@/queries/management-queries";
import { colors, radius, space } from "@/theme/theme";

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

/** A labelled chip group with its consequence underneath. */
function ChipField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <View style={{ gap: space.sm }}>
      <SectionEyebrow style={{ paddingBottom: 0 }}>{label}</SectionEyebrow>
      {children}
      {hint ? (
        <Text type="meta" tone="faint" style={{ paddingHorizontal: space.xs, fontWeight: "400" }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Owner-only channel management: edit name + description, plus a voice-only max
 * participants cap, or delete the channel. Current values are read from the
 * server's details cache. Presented as a modal from the server screen.
 *
 * Koyu Masa: fields on the page, chip groups with their consequence under each,
 * visibility as its own card, deletion in the danger zone behind a sheet that
 * names the channel. Loading draws the form's shape; a failed load says so with a
 * retry, and only a load that SUCCEEDED without the channel says it is gone.
 */
export default function ChannelSettings() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{ channelId: string; groupId: string }>();
  const channelId = params.channelId ?? null;
  const groupId = params.groupId ?? null;
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Slow-mode presets: only the "0 = off" label is language-dependent; the rest
  // are unit-based (5s, 1m, …) and stay verbatim.
  const slowmodeChipOptions = SLOWMODE_PRESETS.map((p) => ({
    key: String(p.value),
    label: p.value === 0 ? t("mobile:slowmode.off") : p.label,
  }));

  const detailsQuery = useGroupDetails(groupId);
  const { data } = detailsQuery;
  const { isOwner, can } = useServerPermissions(groupId);
  const canManageChannels = isOwner || can(PERMISSIONS.MANAGE_CHANNELS);
  const channel = data?.channels.find((c) => c.id === channelId) ?? null;
  const isVoice = channel?.kind === "voice";
  const loadState = resolveEntityLoadState(detailsQuery, channel !== null);

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
    setDeleteError(null);
    deleteChannel.mutate(channelId, {
      onSuccess: () => {
        setConfirmDelete(false);
        router.back();
      },
      onError: (err) => setDeleteError(localizeError(err, t)),
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.app }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.app }}
        contentContainerStyle={{
          padding: space.lg,
          paddingBottom: space.xl + insets.bottom + keyboard,
          gap: space.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Stack.Screen
          options={{
            title: isVoice ? t("mobile:channelSettings.voiceTitle") : t("mobile:channelSettings.title"),
          }}
        />

        {loadState === "loading" ? (
          <View style={{ gap: space.lg }}>
            <Skeleton width="100%" height={44} radius={radius.lg} />
            <Skeleton width="100%" height={88} radius={radius.lg} />
            <Skeleton width="60%" height={40} radius={radius.pill} />
          </View>
        ) : null}

        {loadState === "error" ? (
          <LoadErrorState
            title={t("mobile:channelSettings.loadErrorTitle")}
            error={detailsQuery.error}
            onRetry={() => void detailsQuery.refetch()}
            retrying={detailsQuery.isFetching}
          />
        ) : null}

        {loadState === "missing" ? (
          <EmptyState
            icon={<Hash size={22} color={colors.fgMuted} />}
            title={t("mobile:channelSettings.notFound")}
            action={<Button label={t("common:buttons.back")} variant="secondary" size="sm" onPress={() => router.back()} />}
          />
        ) : null}

        {channel ? (
          <>
            {error ? (
              <Banner variant="danger" title={t("mobile:channelSettings.saveErrorTitle")} description={error} />
            ) : null}

            <View style={{ gap: space.lg }}>
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
                  <ChipField label={t("mobile:channelSettings.bitrateLabel")} hint={t("mobile:channelSettings.bitrateHint")}>
                    <ChipSelect
                      accessibilityLabel={t("mobile:channelSettings.bitrateLabel")}
                      options={bitrateChipOptions}
                      selectedKey={audioBitrate}
                      onSelect={setAudioBitrate}
                    />
                  </ChipField>
                </>
              ) : null}
              {/* Slow mode is offered on BOTH kinds (M20) — it throttles the
                  CHAT, and every voice channel now has one. Hiding it on voice
                  was the last client-side reason a voice channel's conversation
                  was a second-class one. Outside the kind branch above on
                  purpose: one field, not a copy per arm. */}
              <ChipField
                label={t("mobile:channelSettings.slowmode")}
                hint={isVoice ? t("mobile:channelSettings.slowmodeVoiceHint") : t("mobile:channelSettings.slowmodeHint")}
              >
                <ChipSelect
                  accessibilityLabel={t("mobile:channelSettings.slowmode")}
                  options={slowmodeChipOptions}
                  selectedKey={String(slowmodeSeconds)}
                  onSelect={(key) => setSlowmodeSeconds(Number(key))}
                />
              </ChipField>
              {!isVoice ? <NsfwToggle value={nsfw} onChange={setNsfw} /> : null}
              <Button
                label={t("mobile:common.saveChanges")}
                icon={Save}
                variant="accent"
                size="lg"
                block
                onPress={onSave}
                loading={updateChannel.isPending}
              />
            </View>

            {canManageChannels && channelId && groupId ? (
              <ChannelVisibilitySection groupId={groupId} channelId={channelId} />
            ) : null}

            <DangerZone title={t("mobile:common.dangerZone")} description={t("mobile:channelSettings.dangerDescription")}>
              <Button
                label={t("mobile:channelSettings.delete")}
                icon={Trash2}
                variant="danger"
                onPress={() => {
                  setDeleteError(null);
                  setConfirmDelete(true);
                }}
              />
            </DangerZone>
          </>
        ) : null}
      </ScrollView>

      <ConfirmSheet
        visible={confirmDelete}
        title={t("mobile:channelSettings.deleteConfirmTitle")}
        body={t("mobile:channelSettings.deleteConfirmBody", {
          name: channel?.name ?? t("mobile:channelSettings.deleteConfirmFallbackName"),
        })}
        confirmLabel={t("buttons.delete")}
        confirmIcon={Trash2}
        onConfirm={onDelete}
        cancelLabel={t("common:buttons.cancel")}
        onCancel={() => setConfirmDelete(false)}
        busy={deleteChannel.isPending}
        error={deleteError}
        errorTitle={t("mobile:channelSettings.deleteError")}
      />
    </View>
  );
}
