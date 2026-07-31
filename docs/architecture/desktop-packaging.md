# Desktop packaging — Windows + macOS (electron-builder)

Status:

- **Windows — complete and verified.** A real `.exe` + `latest.yml` +
  `.blockmap` are produced from a normal checkout; this is the founder's live
  release path.
- **macOS — config + CI authored, NOT YET RUN.** See "macOS" below; the first
  workflow run is the verification step.

Owner: DevOps/Release.

Turns the `electron-vite` build (`apps/desktop/out/{main,preload,renderer}`)
into installers via
[`apps/desktop/electron-builder.yml`](../../apps/desktop/electron-builder.yml).

## One command

```bash
# bash / git-bash
DEMLI_DOMAIN=demli.example.com pnpm --filter @demli/desktop package:win
DEMLI_DOMAIN=demli.example.com pnpm --filter @demli/desktop package:mac  # macOS host only
```

```powershell
# PowerShell
$env:DEMLI_DOMAIN="demli.example.com"; pnpm --filter @demli/desktop package:win
```

Root `pnpm package:win` / `pnpm package:mac` delegate to the same desktop
scripts. Both run [`apps/desktop/scripts/package.mjs`](../../apps/desktop/scripts/package.mjs),
which replaced the old unreadable `node -e "…"` one-liner in `package.json` —
identical steps, identical flags, now shared between platforms.

### Why `DEMLI_DOMAIN` is mandatory

`package:win` **fails fast** if `DEMLI_DOMAIN` is unset. That single variable
configures two things that must agree, or the app ships broken:

1. **The renderer CSP** (`demli-csp` plugin in `electron.vite.config.ts`) pins
   `connect-src` to `https://api.<domain> wss://ws.<domain> wss://livekit.<domain>`
   — no wildcards, no plaintext. Without the domain the CSP locks to `'self'`
   only (inert).
2. **The renderer's backend URLs.** The client reads `VITE_API_URL` /
   `VITE_REALTIME_URL` at build time (fallback: `localhost`). `package:win`
   **derives** these from `DEMLI_DOMAIN` (`https://api.<domain>`,
   `wss://ws.<domain>`) unless you set them explicitly. This keeps the JS
   connection targets inside the pinned CSP — otherwise the app would try
   `localhost` and its own CSP would block it.

Override the derived URLs only if your API/WS hosts don't follow the
`api.`/`ws.` subdomain convention:

```bash
DEMLI_DOMAIN=demli.example.com \
  VITE_API_URL=https://api.demli.example.com \
  VITE_REALTIME_URL=wss://ws.demli.example.com \
  pnpm --filter @demli/desktop package:win
```

> The LiveKit URL is **not** a build-time renderer var — the client receives it
> from the media-token endpoint at runtime (see `deploy.md`). The CSP already
> allows `wss://livekit.<domain>`.

### `DEMLI_STORAGE_ORIGIN` — required for image save/copy

Attachments are served by **Supabase**, not by `api.<domain>`, so this second
variable is what puts the storage host on two allow-lists:

1. the renderer CSP `img-src` / `media-src`, and
2. the **main process download allow-list** for "save image" / "copy image"
   (`main/image-actions-policy.ts`).

That allow-list is **fail-closed**: with no storage origin pinned it refuses
every URL, and the preload then reports `saveSupported: false` /
`copySupported: false` so the two context-menu entries are not rendered at all.
A build without it is not "slightly looser" — it simply has no image actions.

`package:win` / `package:mac` read it from the gitignored repo-root `.env.deploy`
automatically and print which origin was pinned (or `NOT PINNED`).
`electron.vite.config.ts` reads the same file as a fallback, so
`pnpm dev:desktop` on a machine that has `.env.deploy` also gets working image
actions without exporting anything. On a machine without that file, export
`DEMLI_STORAGE_ORIGIN` before `pnpm dev:desktop` or the entries are hidden
locally — that is the fail-closed rule doing its job, not a bug.

**Founder action, one time, for the macOS CI build:** GitHub Actions has no
`.env.deploy`. Set a repository **variable** (not a secret — it is a public
origin):

> GitHub → repo **Settings → Secrets and variables → Actions → Variables → New
> repository variable** → name `DEMLI_STORAGE_ORIGIN`, value
> `https://<project-ref>.supabase.co` (the same value as in `.env.deploy`).

`.github/workflows/desktop-mac.yml` already reads
`${{ vars.DEMLI_STORAGE_ORIGIN }}`; until the variable exists, every macOS
build ships with image save/copy disabled.

## What `package:win` / `package:mac` do

1. Guard: require `DEMLI_DOMAIN` (clear error + exit 1 if missing) and
   validate it as a hostname.
2. Derive `VITE_API_URL` / `VITE_REALTIME_URL` from it (unless preset).
3. Derive the auto-update feed URL (`DEMLI_UPDATE_URL`, else
   `https://api.<domain>/dl/desktop/`).
4. Report whether `SENTRY_DSN` is set — **without printing it** — so a release
   never silently ships with error monitoring off by accident. Empty is the
   valid default; see [crash-reporting.md](./crash-reporting.md).
5. `electron-vite build` (production mode → pinned CSP + prod URLs baked in).
6. `electron-builder --win|--mac --config electron-builder.yml` with the pinned
   electron version and feed URL (plus the mac signing switch, below).

## Output

`apps/desktop/release/<version>/` (gitignored):

| Artifact                          | Type                                             |
| --------------------------------- | ------------------------------------------------ |
| `Demli-Setup-<version>.exe`    | NSIS installer (per-user, choose-dir, shortcuts) |
| `Demli-Portable-<version>.exe` | Single-file portable, no install                 |
| `win-unpacked/`                   | Unpacked app (`Demli.exe` + `resources/app.asar`) |
| `latest.yml`                      | Auto-update manifest (version + file hashes) — see "Auto-update" |
| `Demli-Setup-<version>.exe.blockmap` | Differential-download map for auto-update |
| `Demli-<version>-<arch>.dmg`   | macOS disk image (drag to Applications) |
| `Demli-<version>-<arch>.zip`   | macOS update payload — required by electron-updater |
| `latest-mac.yml`                  | macOS auto-update manifest |

Install UX (NSIS): one-click **silent** per-user install (no wizard, no admin
prompt), desktop + Start-menu shortcut named "Demli", relaunch after install.
Auto-updates install silently and relaunch — an update must never pop a Setup
wizard.

## Config notes

- **`asar: true`** — the app is packed into `resources/app.asar`.
- **`files` is a POSITIVE include list** (`out/**` + `package.json`). Everything
  — main, preload, renderer, and every npm dependency — is bundled by
  electron-vite into `out/`, and `apps/desktop/package.json` deliberately has
  **zero prod `dependencies`**, so the packaged app ships no `node_modules` at
  all. This is load-bearing twice over: it removes a whole class of recursive
  packaging bugs (the old 347 MB installer), and it keeps the installer small.
  If a future main-process dependency genuinely cannot be bundled (a native
  module), move it to `dependencies`, externalize it in
  `electron.vite.config.ts`, and re-include `node_modules` here — never one
  without the others.
- **`npmRebuild: false`** — no native modules today.
- **Icons** — auto-detected from `apps/desktop/build/icon.ico` (Windows) /
  `build/icon.icns` (macOS) when present; otherwise the default (unbranded)
  Electron icon is used. Missing art never fails the build. See
  [`apps/desktop/build/README.md`](../../apps/desktop/build/README.md).
- **Env hygiene** — `!**/.env*` keeps dev `.env.example` (localhost URLs) out of
  the package. Verified: no `.env`, no `src/`, no secrets in the asar.

### Identity fields — what the 2026-07-31 migration moved

Four identifiers look interchangeable and are not:

| Field | Drives | Status |
| ----- | ------ | ------ |
| `appId` (`app.demli.desktop`) | NSIS upgrade detection, the uninstaller registry entry | **Frozen.** A new appId is a brand-new application to Windows: the installer lands BESIDE the existing install instead of upgrading it, and the old Add/Remove entry stays. Changing it means every user uninstalls and reinstalls once. |
| `productName` (`Demli`) | Exe + window title, artifact filenames, Start-menu shortcut | Yes. Requires renaming the download aliases in the same commit — `pnpm lint:caddy` enforces that. Note it does **not** drive the install directory here (next row). |
| `extraMetadata.name` (`demli-desktop`) | `app.getName()` in the packaged app → the install directory and electron-updater's cache dir | For `oneClick` + per-user installs electron-builder uses the sanitized package `name`, not `productName`, for `%LocalAppData%\Programs\<dir>`. Pinning it keeps the install directory independent of the workspace package name. |
| `publish.channel` (`demli`) | Which manifest the app polls (`demli.yml`) and the forced-update side-car (`demli-critical.json`) | Changing it strands every installed client on the old manifest — a one-click NSIS update installs silently, so the channel is what decides who gets a build. `main/app-identity.test.ts` asserts appId ↔ AppUserModelID and channel ↔ `UPDATE_CHANNEL`. |

### userData — pinned, never derived

Electron derives `userData` from `app.getName()`, which reads `productName` (else
`name`) from the **packaged** `package.json`. That directory holds the
multi-account vault (`account-vault.bin`), the encrypted session token
(`session.bin`), `desktop-settings.json`, the crash log, and Chromium's entire
profile (Local Storage, IndexedDB, Preferences — i.e. drafts, theme, language).
Losing it signs every account out and resets the app to first-run state, silently
and with no way back.

`src/main/user-data-path.ts` therefore **pins** the path to `%APPDATA%\Demli` — it
is never derived — and `src/main/index.ts` applies it before anything reads
`userData` (crash reporter, single-instance lock, secure stores). That is what
keeps `extraMetadata.name` safe: `app.getName()` may move, `userData` does not.

Changing the pinned segments signs every installed user out. It is not a rename to
make as a side effect of anything else; it would need a deliberate, tested
one-shot migration shipped in the same build.
`apps/desktop/src/main/user-data-path.test.ts` pins the path and proves
`main/index.ts` applies it before any consumer.

Also moved harmlessly by the package-name overrides: electron-builder derives
`updaterCacheDirName` from the package name, so the updater's download cache is
now `demli-desktop-updater`. Worst case an already-downloaded update is fetched
once more; the old directory is inert garbage.

## macOS

**Status: config + CI authored on a Windows machine and NEVER EXECUTED.** Nobody
has run a macOS build or launched the produced `.app`. Treat the first workflow
run as the verification step, and expect to iterate.

### Why CI

macOS binaries can only be built on macOS — the `.app` bundle layout, the `dmg`
target, and code signing all need Apple tooling, and there is no cross-build from
Windows. `package:mac` therefore **refuses to run** on a non-Darwin host and
points at the workflow instead.

[`.github/workflows/desktop-mac.yml`](../../.github/workflows/desktop-mac.yml)
runs the same `scripts/package.mjs` on a `macos-latest` runner:

- Trigger, one command from the repo root:

  ```bash
  bash scripts/build-desktop-mac.sh      # dispatch, wait, unpack into release/<version>/
  bash scripts/publish-desktop.sh --mac  # upload + refresh the Demli-macos.dmg alias
  ```

  It needs `GITHUB_TOKEN` in the gitignored `.env.deploy` (fine-grained PAT,
  "Actions: read and write"). `REF=<branch>` and `DEMLI_DOMAIN=` override the
  defaults; `NO_WAIT=1` dispatches and returns. The GitHub UI path is still
  **Actions → "Desktop macOS build" → Run workflow**, and a `desktop-v*` tag push
  also triggers it.
- Steps: install → desktop typecheck → desktop unit tests → `package:mac` →
  upload `*.dmg`, `*.zip`, `*.blockmap`, `latest-mac.yml` as a build artifact.
- **Set the `DEMLI_STORAGE_ORIGIN` repository variable first** (see
  "`DEMLI_STORAGE_ORIGIN` — required for image save/copy" above). The runner
  has no `.env.deploy`, so without it the macOS build ships with image
  save/copy disabled.
- **The workflow must exist on the repository's DEFAULT branch.** GitHub only
  offers `workflow_dispatch` for workflows present there, no matter which ref you
  dispatch. This file currently lives on `dev` only — merge it to the default
  branch (or make `dev` the default) or dispatch answers **404**.
- Cost: Actions minutes are **free on public repos**; macOS runners bill at
  **10×** on private ones. The repo is going public — until then, this is a
  founder budget decision, so check before running it.
- Until the first successful publish, `/download/macos` redirects to an alias
  that does not exist yet, so the landing page must not show a macOS button
  (CLAUDE.md §35).

### Targets

| Artifact | Purpose |
| --- | --- |
| `Demli-<version>-<arch>.dmg` | What a human downloads and drags to Applications |
| `Demli-<version>-<arch>.zip` | **Required by electron-updater** — Squirrel.Mac updates from a zip |
| `latest-mac.yml` | macOS auto-update manifest |

Both `x64` and `arm64` are built. Dropping the zip silently breaks macOS
auto-update, so never publish the dmg alone.

### Code signing (currently UNSIGNED — founder decision)

`mac.identity: null` in `electron-builder.yml`, plus
`CSC_IDENTITY_AUTO_DISCOVERY=false` from the script so a stray keychain identity
on a dev Mac cannot produce an unreproducible "sometimes signed" build.

Unsigned is **free** and works, but Gatekeeper shows *"Demli can't be opened
because it is from an unidentified developer"* on first launch; the user must
right-click → Open once. Signing + notarization require a **paid Apple Developer
membership ($99/year)** — that is a founder call, so it stays off.

**To enable signing, one switch, no file edits:**

```bash
DEMLI_MAC_IDENTITY="Developer ID Application: NAME (TEAMID)" \
  CSC_LINK=/path/cert.p12 CSC_KEY_PASSWORD=… \
  DEMLI_DOMAIN=getdemli.com pnpm --filter @demli/desktop package:mac
```

`scripts/package.mjs` then passes `-c.mac.identity=…`, overriding the null. Add
`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` and it also flips
`notarize` **and** `hardenedRuntime` on (notarization requires both). In CI, add
the same names as repository secrets and set them in the workflow `env:`.

### Known macOS unknowns (unverified)

- The app has only ever run on Windows. Windows-specific main-process code is
  already guarded (`process-audio.ts` returns `unsupported_platform` off
  `win32`; the taskbar overlay falls back to `app.setBadgeCount`), but tray,
  auto-launch, notifications and screen capture are untested on macOS.
- Screen capture on macOS needs the **Screen Recording** TCC permission, which
  is granted in System Settings, not via an Info.plist key. Mic/camera prompts
  are covered by `extendInfo` (`NSMicrophoneUsageDescription`,
  `NSCameraUsageDescription`).
- Multi-arch `latest-mac.yml` behaviour with electron-updater has not been
  exercised.

## Prerequisites / environment gotchas (Windows)

Two Windows-specific hurdles. Both are environmental, not config bugs.

### 1. winCodeSign symlink extraction (REQUIRED fix)

On first Windows build, electron-builder downloads its `winCodeSign` toolchain,
whose archive contains macOS `.dylib` **symlinks**. Extracting symlinks on
Windows needs the "create symbolic links" privilege. Without it the build fails:

```
Cannot create symbolic link : A required privilege is not held by the client
```

Fix (pick one, once per machine):

- **Enable Developer Mode** — Settings → Privacy & security → For developers →
  Developer Mode = On. Grants symlink privilege to your normal user. Recommended.
- **Run the build from an elevated (Administrator) terminal.**

(These macOS files are never used for a Windows build, but the toolchain ships as
one archive.)

### 2. Windows MAX_PATH (260) — build from a short checkout path

NSIS's bundled `makensis` (3.0.4.1) is a legacy Win32 app that is not long-path
aware. Combined with pnpm's long virtual-store dir names, a deeply nested
checkout can push an internal `.nsh` include path past 260 chars and fail:

```
!include: could not open file: "...app-builder-lib\templates\nsis\include\allowOnlyOneInstallerInstance.nsh"
```

- From a short checkout root (~11 chars) the longest include path is **~237
  chars** → **under the limit, builds fine.**
- Building from an agent worktree under `.claude/worktrees/<id>/` pushes it to
  **265 chars** → fails. (That is why such a branch cannot emit the final `.exe`
  in-place; see Verification.)

If your checkout lives at a long path (long username, deep folder) and you hit
this, either:

- move the checkout nearer a drive root, or
- shorten pnpm's store dir names via a root `.npmrc`:
  `virtual-store-dir-max-length=50` (then `pnpm install`), or
- relocate the pnpm virtual store to a short path
  (`.npmrc`: `virtual-store-dir=C:\ps`). *(Root `.npmrc` change — coordinate via
  the Project Director; affects all packages.)*

## Verification

**Windows — verified end to end** (2026-07-27, after the `package.mjs` refactor
and the mac target were added):

- `DEMLI_DOMAIN=getdemli.com pnpm --filter @demli/desktop package:win`
  completed from an agent worktree and emitted
  `Demli-Setup-0.0.64.exe` (83.4 MB), `Demli-Portable-0.0.64.exe`,
  `Demli-Setup-0.0.64.exe.blockmap`, and `latest.yml`.
- The MAX_PATH hazard described above no longer bites: the root `.npmrc` sets
  `node-linker=hoisted` (for the Expo build), which keeps `node_modules` paths
  short. The note is kept because a future linker change would bring it back.
- `package:win` guard verified: fails fast with a clear message when
  `DEMLI_DOMAIN` is unset; does not start the build.

**macOS — NOT verified.** Authored on Windows; no macOS build has been run and
no `.app` has been launched. YAML syntax is validated (`actionlint` clean, the
builder config parses), but that is all. The first CI run is the real test.

## Code signing (currently UNSIGNED)

The `.exe` is not code-signed, so Windows **SmartScreen** shows "Windows
protected your PC" on first run. Users click *More info → Run anyway*. Acceptable
for a private friend-group MVP; sign before any wider distribution.

To sign later (config seam already in `win:`):

- Obtain a **code-signing certificate** (OV is cheaper; **EV** clears SmartScreen
  reputation immediately and is usually a hardware token).
- File-based cert: set env `CSC_LINK` (path/base64 of the `.pfx`) and
  `CSC_KEY_PASSWORD` — electron-builder signs automatically, no config change.
- Token/EV cert: add a `win.signtoolOptions` / custom `sign` hook (electron-builder
  docs) that calls the token's signing tool.
- Never commit the cert or its password (they stay in CI secrets / local env).

> Decision needed from the founder before signing: OV vs EV cert (cost vs instant
> SmartScreen trust) and where the cert/token lives (CI vs local). Escalate to the
> Project Director.

## Auto-update (electron-updater) — WIRED (Milestone 6)

The app updates itself so nobody re-downloads installers by hand. Implemented via
`electron-updater` with the **generic (static) provider**: a release is just files
served over HTTPS.

Code:

- `apps/desktop/src/main/auto-update.ts` — the updater (feed config, event
  wiring, critical vs optional logic, validated IPC). Guarded to `app.isPackaged`,
  so it never runs under `electron-vite dev`.
- `apps/desktop/src/main/auto-update-types.ts` — shared IPC contract + `UpdateStatus`.
- `apps/desktop/src/preload/index.ts` — exposes `window.demli.updates`.
- `apps/desktop/src/renderer/src/components/UpdateSettings.tsx` — the settings
  panel ("Uygulama güncellemeleri") + the blocking critical-update overlay.
- `apps/desktop/electron-builder.yml` — the `publish:` block (bakes the feed URL
  into `app-update.yml`).

### Update flow

- **Optional (default):** on launch the app checks the feed and NOTIFIES. The user
  applies it: **Güncelle** (download) → **Yeniden başlat** (`quitAndInstall`).
  Nothing downloads until asked (`autoDownload = false`).
- **Critical (forced):** if the feed's `critical.json` marks the update mandatory,
  the app auto-downloads and, once ready, `quitAndInstall()` without letting the
  user skip. A blocking "Zorunlu güncelleme" overlay is shown. The real
  enforcement is in the main process, not the UI.

### The feed URL

Baked into `app-update.yml` at package time from `electron-builder.yml`'s
`publish.url`. `package:win` **derives** it (overriding the yml default via
`-c.publish.url=…`), mirroring how the renderer's API/WS URLs are derived:

1. `DEMLI_UPDATE_URL` if set (must be `https`), else
2. `https://dl.<DEMLI_DOMAIN>/desktop/`.

The main process fetches the side-car `critical.json` from the same base. At
runtime, `DEMLI_UPDATE_URL` (https-only) can still override the feed via
`autoUpdater.setFeedURL` (self-host / QA); otherwise the baked URL is used.
**HTTPS only** — a non-https feed/side-car is rejected (updates never pull over
plaintext).

### Release + publish runbook

```bash
# 1. Bump the version in apps/desktop/package.json (e.g. 0.0.1 -> 0.1.0).

# 2. Build the installer + update manifest (bash / git-bash):
#    DEMLI_DOMAIN and DEMLI_STORAGE_ORIGIN are read from the repo-root
#    .env.deploy automatically; export them only to override.
pnpm --filter @demli/desktop package:win
#    Emits, under apps/desktop/release/<version>/:
#      Demli-Setup-<version>.exe          (installer)
#      Demli-Setup-<version>.exe.blockmap (differential map)
#      latest.yml                            (update manifest)

# 3a. Upload those 3 files to the feed root (e.g. https://api.getdemli.com/dl/desktop/)
#     — any static HTTPS host (S3/CloudFront, nginx, a bucket). Overwrite latest.yml.
#     Keep older installers so users mid-download aren't broken.

# 3b. OR let electron-builder upload for you (needs generic-target credentials):
DEMLI_DOMAIN=getdemli.com \
  pnpm --filter @demli/desktop exec electron-builder --win \
  --config electron-builder.yml -c.publish.url=https://api.getdemli.com/dl/desktop/ \
  --publish always
```

The feed must serve (over HTTPS): `latest.yml`, `Demli-Setup-<version>.exe`,
its `.blockmap`, and (optionally) `critical.json`.

### Publishing (the script that is actually used)

`scripts/publish-desktop.sh` uploads a built release to the VPS feed. It
uploads binaries first and the **manifest last**, so a client can never read a
manifest whose binary is not up yet.

```bash
bash scripts/publish-desktop.sh            # Windows only — the default, unchanged
bash scripts/publish-desktop.sh --mac      # macOS artifacts (dmg + zip + latest-mac.yml)
bash scripts/publish-desktop.sh --all      # both
DRY_RUN=1 bash scripts/publish-desktop.sh --all   # list what would upload, touch nothing
```

The two platforms share one feed directory: `latest.yml` and `latest-mac.yml`
sit side by side and electron-updater picks the right one per OS. macOS
publishing hard-fails if the per-arch dmg/zip or `latest-mac.yml` are missing —
download them from the workflow artifact into
`apps/desktop/release/<version>/` first.

### Marking a release critical (forced)

Put a `critical.json` at the feed root next to `latest.yml`:

```json
{ "minVersion": "0.1.0" }
```

Any install **older than** `minVersion` is force-updated on next check. To force
the currently-available release unconditionally, use `{ "critical": true }`.
Remove/blank the file (or lower `minVersion`) to make updates optional again. A
missing or invalid `critical.json` **fails safe to optional** — it never bricks
users into a forced loop.

### Rollout

- **Staged rollout:** host `latest.yml` for a subset first (separate feed/subdomain
  baked into a canary build) before pointing the main feed at the new version.
- **Rollback:** re-upload the previous `latest.yml` + installer (higher-versioned
  clients won't downgrade, but new installs/repairs get the good build).
- **Emergency fix:** ship the new version, then publish `critical.json` with
  `minVersion` = the fixed version to force everyone forward.

### Alternative provider (documented, not used)

Swap the `publish` block for GitHub Releases and electron-updater reads releases
from GitHub instead of a static host:

```yaml
publish:
  provider: github
  owner: <org>
  repo: <repo>
```

Then `electron-builder --publish always` (with a `GH_TOKEN`) uploads the installer,
`latest.yml`, and `.blockmap` as a GitHub release. No app-code change is needed —
only the feed source differs.

### Notes / gotchas

- `electron-updater` is a **runtime `dependency`** (externalized from the main
  bundle, like `zod`), so it ships in `node_modules` inside `app.asar`. This grows
  the package a little; unavoidable (it's `require()`d at runtime).
- **Code signing:** an unsigned NSIS auto-update still installs, but signing is
  strongly recommended before wide distribution (SmartScreen). See "Code signing".
- Hosting choice (which bucket/CDN backs `dl.<domain>`) and the code-signing
  decision remain **founder calls** — escalate to the Project Director.
