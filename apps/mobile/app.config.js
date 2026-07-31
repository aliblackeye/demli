// @ts-check
/**
 * Dynamic config overlay for OTA (EAS Update) critical-update flagging AND the
 * Android FCM credentials file path (task #46 — push notifications).
 *
 * The static config lives in `app.json`. Expo reads `app.json` first and then
 * calls this function with that resolved config as `{ config }`, so this file
 * adds the dynamic bits that must be resolved at eval time:
 *   1. `extra.critical` — the OTA critical-update flag (below), and
 *   2. `android.googleServicesFile` — the FCM `google-services.json` path.
 *
 * Why googleServicesFile is dynamic (task #46): `google-services.json` holds
 * FCM sender credentials and is NOT committed (see .gitignore, commit f7c207c).
 * On EAS it is provided as the secret env `GOOGLE_SERVICES_JSON`, whose value is
 * the path EAS writes the decoded file to; locally (prebuild/dev) it falls back
 * to `./google-services.json`. A static `app.json` cannot read an env var, so
 * this overlay — already the app's dynamic config — is where the path is wired.
 * `npx expo config` only evaluates the config object (no file-existence check),
 * so the fallback path being absent locally is fine; the file is required only
 * at `expo prebuild` / EAS build time.
 *
 * How the critical flag reaches the phone:
 *   - `eas update` embeds the resolved Expo config into the update manifest.
 *   - The app config's `expo.extra` shows up on the client as
 *     `manifest.extra.expoClient.extra` (read in `src/updates/updates.ts`).
 *   - So publishing with `extra.critical === true` marks THAT update critical,
 *     which the client forces on every launch.
 *
 * PRODUCT DECISION (current): every published update is CRITICAL by default.
 * "For now, everyone should always be on the latest." So an ordinary publish —
 * including the automatic one on every push to `master` via
 * `.eas/workflows/publish-update.yml` — ships a forced, block-on-launch update.
 * No env var needed for the common case.
 *
 * Normal (forced) publish — the default:
 *   eas update --branch preview --message "..."
 *
 * Escape hatch — publish an OPTIONAL (banner-only, non-blocking) update by
 * opting OUT for that one command:
 *   DEMLI_CRITICAL_UPDATE=0 eas update --branch preview --message "..."
 *   (Windows PowerShell: $env:DEMLI_CRITICAL_UPDATE=0; eas update --branch preview --message "...")
 *
 * The value baked into a *build* is irrelevant: the client only reads the flag
 * from the INCOMING update's manifest, never from the running build.
 */
const OPTED_OUT =
  process.env.DEMLI_CRITICAL_UPDATE === "0" ||
  process.env.DEMLI_CRITICAL_UPDATE === "false" ||
  process.env.DEMLI_CRITICAL_UPDATE === "off";

const CRITICAL_UPDATE = !OPTED_OUT;

/**
 * FCM credentials path: the EAS secret env (a file path EAS materializes at
 * build time) when present, else the conventional local file for prebuild/dev.
 */
const GOOGLE_SERVICES_JSON = process.env.GOOGLE_SERVICES_JSON ?? "./google-services.json";

module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    googleServicesFile: GOOGLE_SERVICES_JSON,
  },
  updates: {
    ...config.updates,
    // OTA channel for expo-updates. EAS builds inject this from the build
    // profile; a LOCAL (gradle) build does NOT, so an OTA check has no branch to
    // resolve and errors ("Güncelleme denetlenemedi"). Pin the `preview` channel
    // here so locally-built APKs still pull `eas update --branch preview` JS
    // updates — and future JS-only fixes reach them over OTA (no new APK).
    requestHeaders: {
      ...(config.updates?.requestHeaders ?? {}),
      "expo-channel-name": "preview",
    },
  },
  extra: {
    ...config.extra,
    critical: CRITICAL_UPDATE,
  },
});
