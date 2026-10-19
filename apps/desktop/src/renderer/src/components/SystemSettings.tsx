import { useEffect, useState } from "react";
import { Minimize2, MonitorDown, Power } from "lucide-react";
import { Skeleton } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";
import { isDesktopSurface } from "../lib/surface";
import { InlineError, SettingRow, SettingsGroup } from "./settings-kit";
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

/**
 * The "Sistem" settings block: two persisted booleans applied by the main
 * process (close-to-tray governs the window's X; launch-at-startup registers a
 * Windows login item). Each toggle round-trips through the bridge and reflects
 * the authoritative settings the main process returns.
 */
export function SystemSettings(): JSX.Element {
  const { t } = useAppTranslation();
  // Desktop only: the web shim's `system` is an honest no-op (no tray, no login
  // item), so offering its switches there would be two controls that snap back.
  const bridge = isDesktopSurface() ? window.demli?.system : undefined;
  const [settings, setSettings] = useState<DesktopSystemSettings | null>(null);
  const [pending, setPending] = useState(false);
  // A failed read or write is SAID, not swallowed: a switch that silently snaps
  // back reads as a broken control (§26).
  const [failed, setFailed] = useState<"load" | "save" | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    let cancelled = false;
    setFailed(null);
    void bridge
      .getSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch(() => {
        if (!cancelled) setFailed("load");
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, reloadKey]);

  async function update(
    apply: (b: NonNullable<typeof bridge>, next: boolean) => Promise<DesktopSystemSettings>,
    next: boolean,
  ): Promise<void> {
    if (!bridge || pending) {
      return;
    }
    setPending(true);
    setFailed(null);
    try {
      const updated = await apply(bridge, next);
      setSettings(updated);
    } catch {
      // Keep the last-known settings (the switch does not move) and say why.
      setFailed("save");
    } finally {
      setPending(false);
    }
  }

  if (!bridge) {
    return (
      <SettingsGroup title={t("desktop:systemSettings.heading")}>
        <SettingRow
          icon={MonitorDown}
          title={t("desktop:systemSettings.heading")}
          description={t("desktop:systemSettings.webOnly")}
        />
      </SettingsGroup>
    );
  }

  const loading = settings === null && failed !== "load";
  const switchFor = (checked: boolean, label: string, onChange: (next: boolean) => void): JSX.Element =>
    loading ? (
      <Skeleton shape="rect" width={44} height={24} className="rounded-full" />
    ) : (
      <Toggle checked={checked} disabled={settings === null || pending} onChange={onChange} label={label} />
    );

  return (
    <div className="space-y-3">
      <SettingsGroup title={t("desktop:systemSettings.heading")}>
        <SettingRow
          icon={Minimize2}
          title={t("desktop:systemSettings.closeToTray")}
          description={t("desktop:systemSettings.closeToTrayDesc")}
        >
          {switchFor(settings?.closeToTray ?? true, t("desktop:systemSettings.closeToTray"), (next) =>
            void update((b, v) => b.setCloseToTray(v), next),
          )}
        </SettingRow>
        <SettingRow
          icon={Power}
          title={t("desktop:systemSettings.autoLaunch")}
          description={t("desktop:systemSettings.autoLaunchDesc")}
        >
          {switchFor(settings?.autoLaunch ?? false, t("desktop:systemSettings.autoLaunch"), (next) =>
            void update((b, v) => b.setAutoLaunch(v), next),
          )}
        </SettingRow>
      </SettingsGroup>
      {failed && (
        <InlineError
          message={
            failed === "load"
              ? t("desktop:settingsUi.systemLoadFailed")
              : t("desktop:settingsUi.systemSaveFailed")
          }
          retryLabel={failed === "load" ? t("buttons.retry") : undefined}
          onRetry={failed === "load" ? () => setReloadKey((k) => k + 1) : undefined}
        />
      )}
    </div>
  );
}
