/**
 * Native APK download + install — the ONE file that touches the native file
 * system (expo-file-system) and the Android package installer
 * (expo-intent-launcher). Kept isolated so the store/UI stay thin and the pure
 * decision logic (`native-update.ts`) stays import-clean and unit-testable.
 *
 * What it enables (the founder's mission): when a new NATIVE app version exists
 * that OTA cannot deliver, the app downloads the APK ITSELF (with progress) and
 * launches the Android install prompt IN-APP — the user is never sent to a
 * browser/website. Because the file lands at a stable, version-keyed path in the
 * (restart-safe) document dir, a cancelled OS install leaves the APK on disk and
 * the next launch re-detects it and re-launches install WITHOUT re-downloading.
 *
 * Android-only by construction: iOS cannot sideload, so every function is a
 * guarded no-op there (`APK_INSTALL_SUPPORTED` is false) and callers need no
 * platform branch of their own.
 */
import { Platform } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
// `getContentUriAsync` (FileProvider content:// URI) lives only on the legacy
// surface; the modern File API has no equivalent. It uses expo-file-system's
// built-in FileProvider, so no manual FileProvider config is required.
import { getContentUriAsync } from "expo-file-system/legacy";
import * as IntentLauncher from "expo-intent-launcher";
import { apkFileName } from "./native-update";

/** True only where an APK can actually be installed (Android). iOS ⇒ no-op. */
export const APK_INSTALL_SUPPORTED = Platform.OS === "android";

/** MIME type the Android package installer expects for an APK. */
const APK_MIME = "application/vnd.android.package-archive";
/** Intent.FLAG_GRANT_READ_URI_PERMISSION — lets the installer read our URI. */
const FLAG_GRANT_READ_URI_PERMISSION = 1;
/** An APK is never this small; anything under this is treated as truncated/corrupt. */
const MIN_PLAUSIBLE_APK_BYTES = 1_000_000;

/** Folder holding downloaded APKs, under the restart-safe document dir. */
function updatesDir(): Directory {
  return new Directory(Paths.document, "updates");
}

/** The `File` handle for a version's APK (may or may not exist on disk). */
function apkFileFor(version: string): File {
  return new File(updatesDir(), apkFileName(version));
}

/**
 * The already-downloaded APK for `version`, or null. A file that exists but is
 * implausibly small is treated as corrupt: it is deleted and null is returned so
 * the caller re-downloads from a clean slate. Best-effort — any FS error ⇒ null.
 */
export function existingApk(version: string): File | null {
  if (!APK_INSTALL_SUPPORTED) return null;
  try {
    const file = apkFileFor(version);
    if (!file.exists) return null;
    if (file.size < MIN_PLAUSIBLE_APK_BYTES) {
      safeDelete(file);
      return null;
    }
    return file;
  } catch {
    return null;
  }
}

/** Remove any downloaded APK that is NOT for `keepVersion` (reclaim storage). */
export function cleanupStaleApks(keepVersion: string): void {
  if (!APK_INSTALL_SUPPORTED) return;
  try {
    const dir = updatesDir();
    if (!dir.exists) return;
    const keep = apkFileName(keepVersion);
    for (const entry of dir.list()) {
      if (entry instanceof File && entry.name.endsWith(".apk") && entry.name !== keep) {
        safeDelete(entry);
      }
    }
  } catch {
    // Best-effort cleanup; never let it break the update flow.
  }
}

/**
 * Download the APK to its stable, version-keyed path, reporting progress in
 * [0,1]. Clears other versions and any prior partial file first (the download
 * task API is not idempotent), validates the finished size, and returns the
 * `File`. Rejects on network/write failure, a paused/incomplete transfer, or a
 * corrupt (too-small) result.
 */
export async function downloadApk(
  url: string,
  version: string,
  onProgress: (fraction: number) => void,
): Promise<File> {
  if (!APK_INSTALL_SUPPORTED) throw new Error("apk_install_unsupported");

  const dir = updatesDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  cleanupStaleApks(version);

  const dest = apkFileFor(version);
  // Start every attempt from a clean slate so a prior partial write never poisons
  // the result (createDownloadTask has no idempotent overwrite option).
  safeDelete(dest);

  const task = File.createDownloadTask(url, dest, {
    onProgress: ({ bytesWritten, totalBytes }) => {
      // totalBytes is -1 when the server sends no Content-Length; skip those so
      // the bar never jumps to a bogus value.
      if (totalBytes > 0) onProgress(Math.min(1, bytesWritten / totalBytes));
    },
  });

  const file = await task.downloadAsync();
  // A null result means the task was paused before completing — treat as failure
  // so the UI surfaces retry rather than silently "succeeding".
  if (!file) throw new Error("apk_download_incomplete");
  if (file.size < MIN_PLAUSIBLE_APK_BYTES) {
    safeDelete(file);
    throw new Error("apk_download_corrupt");
  }

  onProgress(1);
  return file;
}

/**
 * Launch the Android package installer for an already-downloaded APK. Converts
 * the `file://` path to a FileProvider `content://` URI (mandatory on Android
 * 7+), then fires ACTION_VIEW with the APK MIME and a read grant. The returned
 * promise resolves once the OS installer is dismissed (the launcher uses
 * startActivityForResult), so callers can re-offer "Install" afterwards.
 *
 * On Android 8+ the OS first routes the user to grant "install unknown apps" for
 * Demli if not already granted — that grant is handled entirely by the system.
 */
export async function launchApkInstall(file: File): Promise<void> {
  if (!APK_INSTALL_SUPPORTED) return;
  const contentUri = await getContentUriAsync(file.uri);
  await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
    data: contentUri,
    flags: FLAG_GRANT_READ_URI_PERMISSION,
    type: APK_MIME,
  });
}

/** Delete a file, swallowing errors (missing file, races) — never throws. */
function safeDelete(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // Ignore — deletion is always best-effort in this module.
  }
}
