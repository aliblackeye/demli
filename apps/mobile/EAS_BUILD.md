# EAS builds — Android APK (preview)

> **The primary path is now a LOCAL build** — `pnpm package:android`
> (`scripts/build-mobile-apk.sh`). It needs no EAS quota, signs with the same EAS
> keystore, and is documented in `docs/architecture/deploy.md` → "Android — the
> native APK release". Two constraints it will enforce for you: the signing
> credentials must be in `.env.mobile-signing`, and the build must run from the
> **main checkout**, never a git worktree — the NDK build blows
> past Windows' 260-character path limit from anywhere deeper.
>
> EAS remains the fallback for when build minutes are available; the rest of this
> file covers it, and the runtime-version rules below apply to BOTH paths.

## Build it

```bash
cd apps/mobile
eas build --profile preview --platform android
```

That's it. No `rm -rf node_modules`, no preflight, no clean-install ritual.

## Runtime version = pinned literal (why the build is now deterministic)

The app's OTA runtime version is a fixed string in `app.json`, not a
fingerprint (pinned in commit `89479d8`):

```jsonc
// app.json
"version": "0.1.0",
"runtimeVersion": "1.1.0"
```

The same value on every machine and on the EAS build server — nothing depends
on the state of `node_modules`. Because it is a literal (not the `appVersion`
policy), **bumping `version` alone does NOT change the runtime version**: when
native code changes, bump BOTH `version` and `runtimeVersion` by hand.

> History: `1.0.0` = builds up to M9 (apk-N tags before M10). `1.1.0` = M10
> media attachments — added expo-image-picker / expo-document-picker /
> expo-image-manipulator / expo-file-system / expo-video / expo-audio /
> expo-image (all native), so a new APK build is required; `1.0.0` phones stop
> receiving OTAs (by design — the new JS calls the new native modules).

### Why we don't use the `fingerprint` policy

The first Android build (`fingerprint` policy) failed at **"Configure Expo
Updates"** with:

```
Runtime version calculated on local machine not equal to runtime version
calculated during build.
```

`fingerprint` hashes ~120 sources that live inside `node_modules` — config
plugins **and** the native autolinking dirs. In this pnpm monorepo those paths
differ between a clean hoisted install (what EAS builds against) and a stale or
symlinked one (`node_modules/.pnpm/…`), so the locally-computed fingerprint and
the EAS one diverged and the build was rejected. There is no way to make that
policy immune to `node_modules` layout without gutting what it measures, so it
required a clean reinstall before every build/update. `appVersion` removes that
whole failure class.

## OTA updates

Publish JS-only updates against the current version — delivered to any build
with the same `version`. **Every publish is CRITICAL (forced on launch) by
default** — the product decision is "everyone is always on the latest", so the
automatic publish on every push to `master` blocks each user on launch until
they update:

```bash
cd apps/mobile
# forced-on-launch (the default — see app.config.js):
eas update --branch preview --message "..."
# optional (banner-only, non-blocking) — opt OUT for that one command:
DEMLI_CRITICAL_UPDATE=0 eas update --branch preview --message "..."
```

> An OTA only appears in the app when there is JS **newer** than the installed
> APK on the `preview` branch. Publishing happens automatically on push to
> `master` (`.eas/workflows/publish-update.yml`) — pushing to a feature branch
> publishes nothing, so the app will correctly report "no update".

### The one rule to remember

An OTA update is only safe for builds that share its runtime version (= app
`version`). So when you **change native code** — add/remove/upgrade a native
module (anything under `@livekit/*`, `react-native-*`, a new `expo-*`, a config
plugin, `app.json` native settings) — **bump `version` in `app.json` and ship a
new APK**. Don't OTA new-native JS onto an old APK; keep `version` steady for
pure JS/asset changes and OTA those freely.
