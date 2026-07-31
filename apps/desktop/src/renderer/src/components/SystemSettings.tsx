import { useEffect, useState } from "react";
import { Minimize2, Power } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAppTranslation } from "../lib/i18n";
import { Toggle } from "./Toggle";

/**
 * Desktop system settings (renderer): close-to-tray + launch-at-startup toggles,
 * backed by the validated `window.demli.system` bridge (main owns the tray,
 * login item, and persistence — see `main/system.ts`).
 *
 * The settings type is derived from the global bridge so it can never drift and
 * we never import across the main/ boundary.
 */
type DesktopSystemSettings = Awaited<
  ReturnType<Window["demli"]["system"]["getSettings"]>
>;

function SettingRow({
  icon: Icon,
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3.5">
      <div className="flex min-w-0 gap-3">
        <Icon className="mt-0.5 size-4 shrink-0 text-fg-faint" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">{title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-fg-faint">
            {description}
          </p>
        </div>
      </div>
      <Toggle
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        label={title}
      />
    </div>
  );
}

/**
 * The "Sistem" settings block: two persisted booleans applied by the main
 * process (close-to-tray governs the window's X; launch-at-startup registers a
 * Windows login item). Each toggle round-trips through the bridge and reflects
 * the authoritative settings the main process returns.
 */
export function SystemSettings(): JSX.Element {
  const { t } = useAppTranslation();
  const bridge = window.demli?.system;
  const [settings, setSettings] = useState<DesktopSystemSettings | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    let cancelled = false;
    void bridge
      .getSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  async function update(
    apply: (b: NonNullable<typeof bridge>, next: boolean) => Promise<DesktopSystemSettings>,
    next: boolean,
  ): Promise<void> {
    if (!bridge || pending) {
      return;
    }
    setPending(true);
    try {
      const updated = await apply(bridge, next);
      setSettings(updated);
    } catch {
      // Keep the last-known settings; a failed toggle simply doesn't move.
    } finally {
      setPending(false);
    }
  }

  if (!bridge) {
    return (
      <section className="rounded-xl border border-stroke bg-surface p-5">
        <h2 className="text-sm font-semibold text-fg">{t("desktop:systemSettings.heading")}</h2>
        <p className="mt-2 text-xs text-fg-faint">
          {t("desktop:systemSettings.webOnly")}
        </p>
      </section>
    );
  }

  const loading = settings === null;

  return (
    <section className="rounded-xl border border-stroke bg-surface p-1.5">
      <h2 className="px-3.5 pb-1 pt-2.5 text-sm font-semibold text-fg">
        {t("desktop:systemSettings.heading")}
      </h2>
      <div className="divide-y divide-stroke/60">
        <SettingRow
          icon={Minimize2}
          title={t("desktop:systemSettings.closeToTray")}
          description={t("desktop:systemSettings.closeToTrayDesc")}
          checked={settings?.closeToTray ?? true}
          disabled={loading || pending}
          onChange={(next) => void update((b, v) => b.setCloseToTray(v), next)}
        />
        <SettingRow
          icon={Power}
          title={t("desktop:systemSettings.autoLaunch")}
          description={t("desktop:systemSettings.autoLaunchDesc")}
          checked={settings?.autoLaunch ?? false}
          disabled={loading || pending}
          onChange={(next) => void update((b, v) => b.setAutoLaunch(v), next)}
        />
      </div>
    </section>
  );
}
