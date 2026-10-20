import { useEffect, useRef, useState, type FormEvent } from "react";
import { Hash, Volume2 } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  RadioCard,
  RadioGroup,
  Select,
  Textarea,
} from "@demli/ui";
import { FormErrorAlert } from "@demli/app-ui";
import {
  AUDIO_BITRATE_MAX_KBPS,
  AUDIO_BITRATE_MIN_KBPS,
  AUDIO_BITRATE_PRESETS_KBPS,
  CHANNEL_NAME_MAX_LENGTH,
  isAudioBitratePreset,
  type AudioBitratePresetKbps,
} from "@demli/config";
import { PERMISSIONS } from "@demli/types";
import type { UpdateChannelInput } from "../lib/api-client";
import { errorKey, type CommonErrorKey } from "../lib/errors";
import { useAppTranslation, type AppTFunction } from "../lib/i18n";
import {
  useDeleteChannel,
  useGroupDetails,
  useServerPermissions,
  useUpdateChannel,
} from "../queries/chat-queries";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import { ChannelVisibilitySection } from "./server-settings/ChannelVisibilitySection";
import { NsfwToggle } from "./NsfwToggle";
import { DangerZone, HelpWithCount } from "./settings-kit";

const DESCRIPTION_MAX_LENGTH = 280;

/**
 * Voice bit-rate labels for the offered steps. The VALUES come from
 * `AUDIO_BITRATE_PRESETS_KBPS` in @demli/config (single source, shared with the
 * API + protocol validation) — only the naming lives here, because it is a UI
 * concern. `satisfies Record<AudioBitratePresetKbps, ...>` is the guard that keeps
 * the two in step: add a preset in config without a label here and this stops
 * compiling, rather than shipping a button with a raw key on it.
 */
const BITRATE_LABEL = {
  8: "desktop:channelSettings.bitrateLow",
  64: "desktop:channelSettings.bitrateNormal",
  128: "desktop:channelSettings.bitrateHigh",
} as const satisfies Record<AudioBitratePresetKbps, string>;

/** The picker's options: the media default first, then each offered step. */
const BITRATE_OPTIONS = [
  { value: "", labelKey: "desktop:channelSettings.default", hint: null },
  ...AUDIO_BITRATE_PRESETS_KBPS.map((kbps) => ({
    value: String(kbps),
    labelKey: BITRATE_LABEL[kbps],
    hint: `${kbps} kbps`,
  })),
] as const;

/** Slow-mode presets (seconds) — server accepts any 0–21600, these are the common steps. */
const SLOWMODE_PRESETS: number[] = [
  0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600,
];

/** Localized label for a slow-mode preset ("Off" / "5 seconds" / "2 minutes" / "1 hour"). */
function slowmodeLabel(seconds: number, t: AppTFunction): string {
  if (seconds === 0) return t("desktop:channelSettings.slowmodeOff");
  if (seconds < 60) return t("desktop:channelSettings.slowmodeSecondsN", { count: seconds });
  if (seconds < 3600) {
    return t("desktop:channelSettings.slowmodeMinutesN", { count: seconds / 60 });
  }
  return t("desktop:channelSettings.slowmodeHoursN", { count: seconds / 3600 });
}

/** Error KEY in state, localized at render (follows live locale switches). */
type FormError =
  | CommonErrorKey
  | "desktop:channelSettings.nameRequired"
  | "desktop:channelSettings.maxInvalid"
  | "desktop:channelSettings.bitrateInvalid";

/** Snap a stored slow-mode value to the closest preset so the select can show it. */
function nearestSlowmodePreset(seconds: number): number {
  if (SLOWMODE_PRESETS.includes(seconds)) return seconds;
  let best = SLOWMODE_PRESETS[0]!;
  for (const preset of SLOWMODE_PRESETS) {
    if (Math.abs(preset - seconds) < Math.abs(best - seconds)) best = preset;
  }
  return best;
}

/** Owner-only channel editor: name, topic, voice cap/bitrate, slow mode, delete. */
export function ChannelSettingsDialog(): JSX.Element {
  const { t } = useAppTranslation();
  const channelId = useUiStore((s) => s.channelSettingsChannelId);
  const closeChannelSettings = useUiStore((s) => s.closeChannelSettings);
  const activeGroupId = useChatStore((s) => s.activeGroupId);
  const { data: details } = useGroupDetails(activeGroupId);

  const channel = details?.channels.find((c) => c.id === channelId) ?? null;
  const isVoice = channel?.kind === "voice";

  const { isOwner, can } = useServerPermissions(activeGroupId);
  const canManageChannels = isOwner || can(PERMISSIONS.MANAGE_CHANNELS);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [maxParticipants, setMaxParticipants] = useState("");
  const [slowmodeSeconds, setSlowmodeSeconds] = useState("0");
  const [audioBitrateKbps, setAudioBitrateKbps] = useState("");
  const [nsfw, setNsfw] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);
  /** Danger zone — scrolled into view when the dialog opens with delete intent (task #1). */
  const dangerZoneRef = useRef<HTMLDivElement>(null);

  const updateChannel = useUpdateChannel(activeGroupId);
  const deleteChannel = useDeleteChannel(activeGroupId);
  const busy = updateChannel.isPending || deleteChannel.isPending;

  // Seed fields ONCE per opened channel (keyed by id, not object identity —
  // `find()` returns a fresh object on every query refetch, and reseeding on
  // identity would wipe the user's in-progress edits mid-typing).
  const seededIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!channel) {
      seededIdRef.current = null; // closed — reseed on next open
      return;
    }
    if (seededIdRef.current === channel.id) return;
    seededIdRef.current = channel.id;
    setName(channel.name);
    setDescription(channel.description ?? "");
    setMaxParticipants(
      channel.maxParticipants != null ? String(channel.maxParticipants) : "",
    );
    setSlowmodeSeconds(String(nearestSlowmodePreset(channel.slowmodeSeconds ?? 0)));
    setAudioBitrateKbps(
      channel.audioBitrateKbps != null ? String(channel.audioBitrateKbps) : "",
    );
    setNsfw(channel.nsfw ?? false);
    setError(null);
    setNameTouched(false);
    // Opened from the context-menu Delete: jump straight to the confirm step and
    // reveal the danger zone rather than the generic editor (task #1).
    const deleteIntent = useUiStore.getState().channelSettingsIntent === "delete";
    setConfirmingDelete(deleteIntent);
    if (deleteIntent) {
      requestAnimationFrame(() =>
        dangerZoneRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }),
      );
    }
  }, [channel]);

  const onSave = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || !channelId || !channel) return;
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setNameTouched(true);
      setError("desktop:channelSettings.nameRequired");
      return;
    }

    const patch: { channelId: string } & UpdateChannelInput = {
      channelId,
      name: trimmedName,
      description: description.trim().length > 0 ? description.trim() : null,
    };

    // maxParticipants + audioBitrateKbps stay VOICE-only: they describe the
    // ROOM, which a text channel does not have. Slowmode is sent for BOTH kinds
    // since M20 — it follows the CHAT, and a busy voice channel's sidebar chat is
    // exactly where a spam burst lands. NSFW stays text-only, matching what the
    // create dialog offers. The API rejects each field on the wrong kind, so we
    // only send what applies.
    if (isVoice) {
      const trimmedCap = maxParticipants.trim();
      if (trimmedCap.length > 0) {
        const parsed = Number(trimmedCap);
        if (!Number.isInteger(parsed) || parsed < 1) {
          setError("desktop:channelSettings.maxInvalid");
          return;
        }
        patch.maxParticipants = parsed;
      } else {
        patch.maxParticipants = null;
      }

      // The picker only ever holds "" (media default) or an exact kbps number —
      // either one of the three presets, or the channel's pre-existing custom value
      // carried through untouched. Saving a channel that was set to, say, 256 kbps
      // must NOT quietly rewrite it to the nearest preset, so the custom value stays
      // selectable and round-trips. The range check is kept as a guard against a
      // corrupt stored value, using the API's own (deliberately wider) window.
      const trimmedBitrate = audioBitrateKbps.trim();
      if (trimmedBitrate.length > 0) {
        const parsed = Number(trimmedBitrate);
        if (
          !Number.isInteger(parsed) ||
          parsed < AUDIO_BITRATE_MIN_KBPS ||
          parsed > AUDIO_BITRATE_MAX_KBPS
        ) {
          setError("desktop:channelSettings.bitrateInvalid");
          return;
        }
        patch.audioBitrateKbps = parsed;
      } else {
        patch.audioBitrateKbps = null;
      }
    } else {
      // NSFW is text-only; only ever sent on a text channel.
      patch.nsfw = nsfw;
    }

    const parsedSlowmode = Number(slowmodeSeconds);
    patch.slowmodeSeconds = Number.isInteger(parsedSlowmode) ? parsedSlowmode : 0;

    setError(null);
    updateChannel.mutate(patch, {
      onSuccess: () => closeChannelSettings(),
      onError: (err) => setError(errorKey(err)),
    });
  };

  const onDelete = (): void => {
    if (busy || !channelId) return;
    setError(null);
    deleteChannel.mutate(channelId, {
      onSuccess: () => closeChannelSettings(),
      onError: (err) => setError(errorKey(err)),
    });
  };

  const nameError =
    error === "desktop:channelSettings.nameRequired" || (nameTouched && name.trim().length === 0)
      ? t("desktop:channelSettings.nameRequired")
      : undefined;
  const maxError = error === "desktop:channelSettings.maxInvalid" ? t(error) : undefined;
  const formError =
    error !== null &&
    error !== "desktop:channelSettings.nameRequired" &&
    error !== "desktop:channelSettings.maxInvalid"
      ? t(error)
      : null;
  const customBitrate =
    audioBitrateKbps !== "" &&
    Number.isFinite(Number(audioBitrateKbps)) &&
    !isAudioBitratePreset(Number(audioBitrateKbps));
  const slowmodeOptions = SLOWMODE_PRESETS.map((preset) => ({
    value: String(preset),
    label: slowmodeLabel(preset, t),
  }));

  return (
    <Dialog open={channelId !== null} onOpenChange={(next) => !next && closeChannelSettings()}>
      <DialogContent closeLabel={t("buttons.close")} className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("desktop:channelSettings.title")}</DialogTitle>
          <DialogDescription className="inline-flex items-center gap-1.5">
            {isVoice ? <Volume2 aria-hidden className="size-3.5" /> : <Hash aria-hidden className="size-3.5" />}
            {isVoice ? t("desktop:channelSettings.voiceChannel") : t("desktop:channelSettings.textChannel")}
            {channel ? ` — ${channel.name}` : ""}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-7">
          {formError && <FormErrorAlert>{formError}</FormErrorAlert>}

          <form id="channel-settings-form" onSubmit={onSave} noValidate className="space-y-5">
            <Field
              label={t("desktop:channelSettings.name")}
              error={nameError}
              help={<HelpWithCount value={name} max={CHANNEL_NAME_MAX_LENGTH} />}
            >
              <Input
                id="channel-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (error === "desktop:channelSettings.nameRequired") setError(null);
                }}
                onBlur={() => setNameTouched(true)}
                maxLength={CHANNEL_NAME_MAX_LENGTH}
                spellCheck={false}
                placeholder={
                  isVoice
                    ? t("desktop:channelSettings.namePlaceholderVoice")
                    : t("desktop:channelSettings.namePlaceholderText")
                }
              />
            </Field>

            <Field
              label={
                <>
                  {t("desktop:channelSettings.topic")}{" "}
                  <span className="font-normal text-fg-faint">{t("desktop:profile.optional")}</span>
                </>
              }
              help={<HelpWithCount value={description} max={DESCRIPTION_MAX_LENGTH} />}
            >
              <Textarea
                id="channel-topic"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={DESCRIPTION_MAX_LENGTH}
                rows={3}
                placeholder={t("desktop:channelSettings.topicPlaceholder")}
                className="resize-none"
              />
            </Field>

            {isVoice ? (
              <>
                <Field
                  label={
                    <>
                      {t("desktop:channelSettings.maxParticipants")}{" "}
                      <span className="font-normal text-fg-faint">{t("desktop:profile.optional")}</span>
                    </>
                  }
                  error={maxError}
                  help={t("desktop:channelSettings.maxNote")}
                >
                  <Input
                    id="channel-max"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    value={maxParticipants}
                    onChange={(event) => {
                      setMaxParticipants(event.target.value);
                      if (error === "desktop:channelSettings.maxInvalid") setError(null);
                    }}
                    placeholder={t("desktop:channelSettings.noLimit")}
                    className="w-36"
                  />
                </Field>

                <div className="space-y-2">
                  <p id="channel-bitrate-label" className="text-label font-medium text-fg-muted">
                    {t("desktop:channelSettings.bitrate")}{" "}
                    <span className="font-normal text-fg-faint">{t("desktop:channelSettings.bitrateUnit")}</span>
                  </p>
                  {/* Media default, then the offered steps. A channel already set
                      to something else keeps its own option below, so opening this
                      dialog can never silently downgrade it. */}
                  <RadioGroup
                    value={audioBitrateKbps === "" ? "default" : audioBitrateKbps}
                    onValueChange={(next) => setAudioBitrateKbps(next === "default" ? "" : next)}
                    disabled={busy}
                    aria-labelledby="channel-bitrate-label"
                    className="grid grid-cols-2 gap-1.5"
                  >
                    {BITRATE_OPTIONS.map((option) => (
                      <RadioCard
                        key={option.value || "default"}
                        value={option.value || "default"}
                        align="start"
                        label={t(option.labelKey)}
                        detail={option.hint ?? t("desktop:channelSettings.bitrateDefaultHint")}
                      />
                    ))}
                    {/* The channel's existing value when it is not one of the offered
                        steps (set before the presets landed, or via the API). Shown
                        honestly as a custom value and kept selected rather than being
                        snapped to a neighbour — snapping would change a configuration
                        the owner never touched. */}
                    {customBitrate && (
                      <RadioCard
                        value={audioBitrateKbps}
                        align="start"
                        label={t("desktop:channelSettings.bitrateCustom")}
                        detail={`${Number(audioBitrateKbps)} kbps`}
                      />
                    )}
                  </RadioGroup>
                  <p className="text-label text-fg-faint">{t("desktop:channelSettings.bitrateNote")}</p>
                </div>
              </>
            ) : (
              <NsfwToggle checked={nsfw} onChange={setNsfw} disabled={busy} />
            )}

            {/* Slowmode is offered on BOTH kinds (M20): it throttles the CHAT,
                and every voice channel now has one. Hiding it here was the last
                client-side reason a voice channel's conversation was a
                second-class one — the API has accepted it since the backend
                wave. Note it is deliberately OUTSIDE the kind branch above, so
                there is one field, not a copy per arm. */}
            <Field
              label={t("desktop:channelSettings.slowmode")}
              help={
                isVoice ? t("desktop:channelSettings.slowmodeVoiceNote") : t("desktop:channelSettings.slowmodeNote")
              }
            >
              <Select
                id="channel-slowmode"
                options={slowmodeOptions}
                value={slowmodeSeconds}
                onValueChange={setSlowmodeSeconds}
                placeholder={t("desktop:channelSettings.slowmodeOff")}
              />
            </Field>
          </form>

          {canManageChannels && channelId && activeGroupId && (
            <div className="pt-6 shadow-[inset_0_1px_0_var(--color-stroke)]">
              <ChannelVisibilitySection groupId={activeGroupId} channelId={channelId} />
            </div>
          )}

          <DangerZone
            innerRef={dangerZoneRef}
            title={t("desktop:channel.delete")}
            body={t("desktop:channelSettings.deleteNote")}
            actionLabel={t("desktop:channel.delete")}
            confirmLabel={t("desktop:channelSettings.confirmDelete")}
            cancelLabel={t("buttons.cancel")}
            onConfirm={onDelete}
            pending={deleteChannel.isPending}
            disabled={updateChannel.isPending}
            confirming={confirmingDelete}
            onConfirmingChange={setConfirmingDelete}
          />
        </DialogBody>

        <DialogFooter className="pt-4 shadow-[inset_0_1px_0_var(--color-stroke)]">
          <Button type="button" variant="ghost" disabled={busy} onClick={() => closeChannelSettings()}>
            {t("buttons.cancel")}
          </Button>
          <Button type="submit" form="channel-settings-form" variant="accent" loading={updateChannel.isPending} disabled={deleteChannel.isPending}>
            {t("desktop:channelSettings.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
