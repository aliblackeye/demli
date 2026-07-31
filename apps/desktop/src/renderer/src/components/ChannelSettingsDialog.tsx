import { useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  cn,
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

/** Native <select> styled to match the Input primitive (dark-first). */
const selectClass = [
  "h-9 w-full rounded-md border border-stroke bg-raised px-2.5 text-sm text-fg",
  "transition-colors motion-instant",
  "focus:outline-none focus-visible:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent/30",
  "disabled:pointer-events-none disabled:opacity-50",
].join(" ");

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

  const textareaClass = cn(
    "w-full resize-none rounded-md border border-stroke bg-raised px-3 py-2 text-sm text-fg",
    "placeholder:text-fg-faint transition-colors motion-instant",
    "focus:outline-none focus-visible:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent/30",
  );

  return (
    <Dialog open={channelId !== null} onOpenChange={(next) => !next && closeChannelSettings()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("desktop:channelSettings.title")}</DialogTitle>
          <DialogDescription>
            {isVoice
              ? t("desktop:channelSettings.voiceChannel")
              : t("desktop:channelSettings.textChannel")}
            {channel ? ` — ${channel.name}` : ""}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {error && <FormErrorAlert className="mb-3">{t(error)}</FormErrorAlert>}

          <form onSubmit={onSave} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="channel-name" className="block text-xs font-semibold text-fg-muted">
                {t("desktop:channelSettings.name")}
              </label>
              <Input
                id="channel-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={CHANNEL_NAME_MAX_LENGTH}
                spellCheck={false}
                placeholder={
                  isVoice
                    ? t("desktop:channelSettings.namePlaceholderVoice")
                    : t("desktop:channelSettings.namePlaceholderText")
                }
                aria-label={t("desktop:createChannel.nameLabel")}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="channel-topic" className="block text-xs font-semibold text-fg-muted">
                {t("desktop:channelSettings.topic")}{" "}
                <span className="font-normal text-fg-faint">{t("desktop:profile.optional")}</span>
              </label>
              <textarea
                id="channel-topic"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={DESCRIPTION_MAX_LENGTH}
                rows={3}
                placeholder={t("desktop:channelSettings.topicPlaceholder")}
                aria-label={t("desktop:channelSettings.topic")}
                className={textareaClass}
              />
            </div>

            {isVoice ? (
              <>
                <div className="space-y-1.5">
                  <label
                    htmlFor="channel-max"
                    className="block text-xs font-semibold text-fg-muted"
                  >
                    {t("desktop:channelSettings.maxParticipants")}{" "}
                    <span className="font-normal text-fg-faint">
                      {t("desktop:profile.optional")}
                    </span>
                  </label>
                  <Input
                    id="channel-max"
                    type="number"
                    min={1}
                    step={1}
                    value={maxParticipants}
                    onChange={(event) => setMaxParticipants(event.target.value)}
                    placeholder={t("desktop:channelSettings.noLimit")}
                    aria-label={t("desktop:channelSettings.maxParticipants")}
                    className="w-32"
                  />
                  <p className="text-2xs text-fg-faint">
                    {t("desktop:channelSettings.maxNote")}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <span className="block text-xs font-semibold text-fg-muted">
                    {t("desktop:channelSettings.bitrate")}{" "}
                    <span className="font-normal text-fg-faint">
                      {t("desktop:channelSettings.bitrateUnit")}
                    </span>
                  </span>
                  <div
                    role="radiogroup"
                    aria-label={t("desktop:channelSettings.bitrateAria")}
                    className="grid grid-cols-2 gap-1"
                  >
                    {/* Media default, then the offered steps. A channel already set
                        to something else keeps its own option below, so opening this
                        dialog can never silently downgrade it. */}
                    {BITRATE_OPTIONS.map((option) => {
                      const selected = audioBitrateKbps === option.value;
                      return (
                        <button
                          key={option.value || "default"}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          disabled={busy}
                          onClick={() => setAudioBitrateKbps(option.value)}
                          className={cn(
                            "cursor-pointer rounded-md border px-2 py-2 text-left transition-colors motion-instant",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                            selected
                              ? "border-accent/60 bg-accent/10"
                              : "border-stroke bg-raised hover:border-stroke-strong",
                          )}
                        >
                          <span
                            className={cn(
                              "block text-sm font-medium",
                              selected ? "text-fg" : "text-fg-muted",
                            )}
                          >
                            {t(option.labelKey)}
                          </span>
                          <span className="mt-0.5 block text-2xs leading-tight text-fg-faint">
                            {option.hint ?? t("desktop:channelSettings.bitrateDefaultHint")}
                          </span>
                        </button>
                      );
                    })}
                    {/* The channel's existing value when it is not one of the offered
                        steps (set before the presets landed, or via the API). Shown
                        honestly as a custom value and kept selected rather than being
                        snapped to a neighbour — snapping would change a configuration
                        the owner never touched. */}
                    {audioBitrateKbps !== "" &&
                      Number.isFinite(Number(audioBitrateKbps)) &&
                      !isAudioBitratePreset(Number(audioBitrateKbps)) && (
                        <button
                          type="button"
                          role="radio"
                          aria-checked
                          disabled={busy}
                          onClick={() => undefined}
                          className="cursor-default rounded-md border border-accent/60 bg-accent/10 px-2 py-2 text-left"
                        >
                          <span className="block text-sm font-medium text-fg">
                            {t("desktop:channelSettings.bitrateCustom")}
                          </span>
                          <span className="mt-0.5 block text-2xs leading-tight text-fg-faint">
                            {`${Number(audioBitrateKbps)} kbps`}
                          </span>
                        </button>
                      )}
                  </div>
                  <p className="text-2xs text-fg-faint">
                    {t("desktop:channelSettings.bitrateNote")}
                  </p>
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
            <div className="space-y-1.5">
              <label
                htmlFor="channel-slowmode"
                className="block text-xs font-semibold text-fg-muted"
              >
                {t("desktop:channelSettings.slowmode")}
              </label>
              <select
                id="channel-slowmode"
                value={slowmodeSeconds}
                onChange={(event) => setSlowmodeSeconds(event.target.value)}
                aria-label={t("desktop:channelSettings.slowmode")}
                className={selectClass}
              >
                {SLOWMODE_PRESETS.map((preset) => (
                  <option key={preset} value={String(preset)}>
                    {slowmodeLabel(preset, t)}
                  </option>
                ))}
              </select>
              <p className="text-2xs text-fg-faint">
                {isVoice
                  ? t("desktop:channelSettings.slowmodeVoiceNote")
                  : t("desktop:channelSettings.slowmodeNote")}
              </p>
            </div>

            <Button type="submit" disabled={busy} className="w-full">
              {updateChannel.isPending && <Loader2 className="size-4 animate-spin" />}
              {t("desktop:channelSettings.save")}
            </Button>
          </form>

          {canManageChannels && channelId && activeGroupId && (
            <ChannelVisibilitySection groupId={activeGroupId} channelId={channelId} />
          )}

          <div
            ref={dangerZoneRef}
            className="mt-6 rounded-lg border border-danger/30 bg-danger/[0.06] p-4"
          >
            <p className="text-sm font-semibold text-fg">{t("desktop:channel.delete")}</p>
            <p className="mt-1 text-xs leading-relaxed text-fg-muted">
              {t("desktop:channelSettings.deleteNote")}
            </p>
            {confirmingDelete ? (
              <div className="mt-3 flex gap-2">
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  onClick={onDelete}
                  className="flex-1"
                >
                  {deleteChannel.isPending && <Loader2 className="size-4 animate-spin" />}
                  {t("desktop:channelSettings.confirmDelete")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirmingDelete(false)}
                  className="flex-1"
                >
                  {t("buttons.cancel")}
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmingDelete(true)}
                className="mt-3 border-danger/40 text-danger hover:bg-danger/10"
              >
                {t("desktop:channel.delete")}
              </Button>
            )}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
