/**
 * Native-update store (Zustand — matches the app's other stores).
 *
 * Parallel to the OTA store (`updates-store.ts`) but for the NATIVE runtime: on
 * launch it asks the API for the newest shipped runtime + APK link (public GET
 * /mobile/version), reads the device's own runtimeVersion, and resolves a level:
 *
 *   none      up to date / undecidable — render nothing
 *   optional  a newer native build exists — render a dismissible banner
 *   forced    below the supported floor — render a blocking screen
 *
 * When behind, the app does the WHOLE update IN-APP (the founder's mission): it
 * downloads the APK itself with progress, then launches the Android install
 * prompt — the user is NEVER sent to a browser/website. A cancelled OS install
 * keeps the downloaded APK on disk (its presence is the "pending install"
 * marker), so the next launch re-detects it and re-offers Install WITHOUT
 * re-downloading. The install phase machine:
 *
 *   idle → downloading (progress %) → downloaded (Install) → installing → error
 *
 * Never blocks on failure: a network/parse error leaves the level untouched
 * (default `none`) and the user proceeds — the same "optional path never blocks"
 * rule the OTA store follows. The only escape from `forced` is installing the new
 * APK, which is exactly the point (OTA cannot deliver a new native runtime).
 *
 * The native reads/writes live in `native-apk.ts` (FS + install intent) and the
 * device runtime read is here (expo-constants); the pure comparison is
 * `decideNativeUpdate`, so the decision is unit-tested without native modules.
 */
import Constants from "expo-constants";
import { create } from "zustand";
import { getApi } from "@/lib/clients";
import {
  APK_INSTALL_SUPPORTED,
  downloadApk,
  existingApk,
  launchApkInstall,
} from "./native-apk";
import { decideNativeUpdate, type NativeUpdateLevel } from "./native-update";
import { updatesEnabled } from "./updates";

/** The device's baked native runtime, or null in dev / when unreadable. */
function deviceRuntimeVersion(): string | null {
  const rv = Constants.expoConfig?.runtimeVersion;
  return typeof rv === "string" ? rv : null;
}

/** Lifecycle of the in-app download → install flow (Android). */
export type InstallPhase = "idle" | "downloading" | "downloaded" | "installing" | "error";

interface NativeUpdateStore {
  level: NativeUpdateLevel;
  /** Download link from the last successful check; null until then. */
  apkUrl: string | null;
  /** Runtime version the advertised APK ships — the on-disk key for the download. */
  targetVersion: string | null;
  bannerDismissed: boolean;
  lastCheckAt: number | null;
  checking: boolean;

  /** In-app install lifecycle + download progress (0..1). */
  phase: InstallPhase;
  progress: number;

  /** Fetch the advertised version, compare locally, set level + apkUrl. Best-effort. */
  check: () => Promise<void>;
  /**
   * Download the APK (if not already on disk) then launch the OS installer.
   * The single entry for the forced auto-flow and the optional "Update" button.
   */
  startUpdate: () => Promise<void>;
  /**
   * Re-launch the installer for an ALREADY-downloaded APK without re-downloading
   * (the manual affordance after an OS-install cancel). Falls back to a full
   * download if the file is gone.
   */
  installDownloaded: () => Promise<void>;
  /** Hide the optional banner for this session (forced screen is not dismissible). */
  dismissBanner: () => void;
}

export const useNativeUpdateStore = create<NativeUpdateStore>()((set, get) => ({
  level: "none",
  apkUrl: null,
  targetVersion: null,
  bannerDismissed: false,
  lastCheckAt: null,
  checking: false,
  phase: "idle",
  progress: 0,

  check: async () => {
    // Only meaningful in a real shipped build. In Expo Go / a dev client
    // `updatesEnabled()` is false, so we never nag a developer running locally
    // (mirrors the OTA store's guard — the two mechanisms stay in lockstep here).
    if (!updatesEnabled()) return;
    if (get().checking) return;

    set({ checking: true });
    try {
      const info = await getApi().getMobileVersion();
      const level = decideNativeUpdate({
        currentRuntime: deviceRuntimeVersion(),
        latestRuntimeVersion: info.latestRuntimeVersion,
        minSupportedRuntimeVersion: info.minSupportedRuntimeVersion,
      });
      set({
        level,
        apkUrl: info.apkUrl,
        targetVersion: info.latestRuntimeVersion,
        lastCheckAt: Date.now(),
        checking: false,
      });

      // If the target APK is already downloaded (e.g. a prior OS-install cancel),
      // surface Install straight away without re-downloading. Only promote from a
      // resting `idle`; never clobber an in-flight download/install/error.
      if (level !== "none" && get().phase === "idle" && existingApk(info.latestRuntimeVersion)) {
        set({ phase: "downloaded", progress: 1 });
      }
    } catch {
      // Never block on failure: keep whatever level we had (default none).
      set({ checking: false, lastCheckAt: Date.now() });
    }
  },

  startUpdate: async () => {
    if (!APK_INSTALL_SUPPORTED) return; // iOS can't sideload — no-op.
    const { apkUrl, targetVersion, phase } = get();
    if (!apkUrl || !targetVersion) return;
    if (phase === "downloading" || phase === "installing") return; // re-entry guard.

    try {
      let file = existingApk(targetVersion);
      if (!file) {
        set({ phase: "downloading", progress: 0 });
        file = await downloadApk(apkUrl, targetVersion, (fraction) => set({ progress: fraction }));
      }
      set({ phase: "installing" });
      await launchApkInstall(file);
      // Installer dismissed. Keep the APK and re-offer Install (the user may have
      // cancelled; on success the app is replaced and this state never renders).
      set({ phase: "downloaded" });
    } catch {
      set({ phase: "error" });
    }
  },

  installDownloaded: async () => {
    if (!APK_INSTALL_SUPPORTED) return;
    const { targetVersion, phase } = get();
    if (!targetVersion) return;
    if (phase === "downloading" || phase === "installing") return;

    const file = existingApk(targetVersion);
    if (!file) {
      // Nothing on disk (cleared under storage pressure) — fall back to download.
      void get().startUpdate();
      return;
    }
    try {
      set({ phase: "installing" });
      await launchApkInstall(file);
      set({ phase: "downloaded" });
    } catch {
      set({ phase: "error" });
    }
  },

  dismissBanner: () => set({ bannerDismissed: true }),
}));
