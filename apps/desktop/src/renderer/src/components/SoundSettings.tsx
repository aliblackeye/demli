import type { ReactNode } from "react";
import { BellRing, Volume2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";
import { playSound } from "../sounds/sound-manager";
import { useSoundSettings } from "../sounds/sound-settings";
import { Toggle } from "./Toggle";

/**
 * "Sesler" settings section — UI sound effect preferences (master switch,
 * volume, message-notification switch). State lives in the persisted
 * `useSoundSettings` store; this component is a thin view over it.
 * Enabling a switch (and releasing the volume slider) plays a sample cue so
 * the user hears the result immediately.
 */

function SettingRow({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3.5">
      <div className="flex min-w-0 gap-3">
        <Icon className="mt-0.5 size-4 shrink-0 text-fg-faint" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">{title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-fg-faint">{description}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

export function SoundSettings(): JSX.Element {
  const { t } = useAppTranslation();
  const enabled = useSoundSettings((s) => s.enabled);
  const volume = useSoundSettings((s) => s.volume);
  const messageEnabled = useSoundSettings((s) => s.messageEnabled);
  const setEnabled = useSoundSettings((s) => s.setEnabled);
  const setVolume = useSoundSettings((s) => s.setVolume);
  const setMessageEnabled = useSoundSettings((s) => s.setMessageEnabled);

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-stroke bg-surface p-1.5">
        <h2 className="px-3.5 pb-1 pt-2.5 text-sm font-semibold text-fg">
          {t("desktop:sound.heading")}
        </h2>
        <div className="divide-y divide-stroke/60">
          <SettingRow
            icon={Volume2}
            title={t("desktop:sound.effects")}
            description={t("desktop:sound.effectsDesc")}
          >
            <Toggle
              checked={enabled}
              onChange={(next) => {
                setEnabled(next);
                if (next) playSound("voice-join");
              }}
              label={t("desktop:sound.effects")}
            />
          </SettingRow>

          <div className={cn("px-4 py-3.5", !enabled && "opacity-50")}>
            <div className="flex items-center justify-between gap-4">
              <label
                htmlFor="ui-sound-volume"
                className="text-sm font-medium text-fg"
              >
                {t("desktop:sound.volume")}
              </label>
              <span className="text-xs tabular-nums text-fg-muted">
                {Math.round(volume * 100)}%
              </span>
            </div>
            <input
              id="ui-sound-volume"
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(volume * 100)}
              disabled={!enabled}
              onChange={(e) => setVolume(Number(e.target.value) / 100)}
              // Sample on release (not on every drag tick) so adjusting
              // doesn't machine-gun the cue.
              onPointerUp={() => playSound("voice-join")}
              onKeyUp={() => playSound("voice-join")}
              className={cn(
                "mt-2.5 h-1.5 w-full appearance-auto accent-accent",
                enabled ? "cursor-pointer" : "cursor-not-allowed",
              )}
            />
          </div>

          <SettingRow
            icon={BellRing}
            title={t("desktop:sound.messageNotif")}
            description={t("desktop:sound.messageNotifDesc")}
          >
            <Toggle
              checked={messageEnabled}
              disabled={!enabled}
              onChange={(next) => {
                setMessageEnabled(next);
                if (next) playSound("message");
              }}
              label={t("desktop:sound.messageNotif")}
            />
          </SettingRow>
        </div>
      </section>
      <p className="text-xs leading-relaxed text-fg-faint">
        {t("desktop:sound.note")}
      </p>
    </div>
  );
}
