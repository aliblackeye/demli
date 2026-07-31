import { join } from "node:path";

/**
 * Where the desktop app keeps its per-user state — pinned, on purpose.
 *
 * WHAT LIVES THERE: the multi-account vault (`account-vault.bin`, ADR 0013), the
 * encrypted session token (`session.bin`), `desktop-settings.json`, the crash
 * log, and Chromium's own profile (Local Storage / IndexedDB / Preferences), i.e.
 * drafts, theme, language and every renderer-side preference. Losing this
 * directory logs every account out and resets the app to first-run state.
 *
 * WHY IT IS PINNED RATHER THAN DERIVED
 * ------------------------------------
 * Electron derives userData from `app.getName()`, which reads `productName` (else
 * `name`) out of the packaged package.json. A rename of the product, of the npm
 * scope, or an `extraMetadata.name` in electron-builder.yml each move
 * `app.getName()` — and with it userData: users would open the "updated" app and
 * find a signed-out, empty install with no error and no way back. Pinning the
 * path is what keeps `extraMetadata.name: demli-desktop` safe.
 *
 * Changing {@link PACKAGED_USER_DATA_SEGMENTS} signs every installed user out.
 * It is not a rename to make as a side effect of anything else: it would need a
 * deliberate, tested one-shot migration shipped in the same build.
 */

/** Directory segments appended to the OS app-data dir for a packaged install. */
export const PACKAGED_USER_DATA_SEGMENTS = ["Demli"] as const;

/**
 * Directory used by unpackaged runs (`pnpm dev:desktop`). Separate on purpose:
 * Electron's single-instance lock keys on the userData path, so sharing it would
 * make a dev preview quit whenever the installed app is running — and dev tokens
 * and drafts would pollute the real install.
 */
export const DEV_USER_DATA_DIR = "demli-dev";

/**
 * Resolve the userData directory for this run.
 *
 * @param appDataDir - `app.getPath("appData")` (%APPDATA% / ~/Library/Application Support).
 * @param isPackaged - `app.isPackaged`.
 */
export function resolveUserDataPath(appDataDir: string, isPackaged: boolean): string {
  if (!isPackaged) {
    return join(appDataDir, DEV_USER_DATA_DIR);
  }
  return join(appDataDir, ...PACKAGED_USER_DATA_SEGMENTS);
}
