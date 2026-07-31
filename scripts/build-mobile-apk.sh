#!/usr/bin/env bash
# Build a SHIPPABLE Android release APK locally — no EAS build quota needed.
#
# Why this exists: EAS free-tier build minutes run out, but a native release is
# required whenever `runtimeVersion` changes (new native module, new app icon,
# new app name — none of which OTA can deliver). Everything EAS does for the
# `preview` profile is reproducible on this machine; the only piece EAS holds
# that we cannot regenerate is the SIGNING KEY, and that is exactly the piece
# that must not be improvised (see "Signing" below).
#
# Usage (from the repo root):
#   bash scripts/build-mobile-apk.sh
#   bash scripts/build-mobile-apk.sh --no-clean     # keep the existing android/ dir
#
# On success it prints the APK path and the publish command to run next.
#
# ---------------------------------------------------------------------------
# Signing — READ THIS BEFORE CHANGING ANYTHING
# ---------------------------------------------------------------------------
# Android will only install an update over an existing app when BOTH APKs are
# signed with the SAME key. The installed base was signed by EAS, so a local
# build must be signed with the EAS keystore or:
#   - every existing user's in-app update fails with a signature mismatch, and
#   - anyone who installs the mis-signed APK fresh is stranded on it forever
#     (no future correctly-signed build can update them either).
#
# The Expo android template signs `release` with the DEBUG keystore, which is
# checked into every prebuild. That default is a trap: the build succeeds, the
# APK installs on a clean phone, and the breakage only surfaces at the NEXT
# release. This script therefore refuses to run without real credentials rather
# than falling back to it.
#
# Credentials live in a gitignored `.env.mobile-signing` at the repo root (same
# pattern as `.env.deploy`). Get them from EAS — they are stored there:
#
#   cd apps/mobile
#   npx eas-cli credentials --platform android
#     -> select the `preview` build profile
#     -> "Keystore: Manage everything needed to build your project"
#     -> "Download existing keystore"
#   EAS writes the .jks and PRINTS the keystore password, key alias and key
#   password. Put them in .env.mobile-signing:
#
#   EAS names the download after the account + slug (`@<account>__<slug>.jks`).
#   Rename it to the neutral name below — the filename is ours, nothing verifies
#   it, and a path carrying a personal account handle does not belong in a public
#   repo's docs:
#
#     mv apps/mobile/@<account>__<slug>.jks apps/mobile/demli-release.jks
#
#   The signing key is not bound to a package id, and this script never talks to
#   EAS at build time — only an `eas build` fallback would need the key uploaded
#   to the EAS project. Keep signing with the SAME key: a new one means installed
#   users can never update, and the `assetlinks.json` certificate digest breaks.
#
#     MOBILE_KEYSTORE_PATH=apps/mobile/demli-release.jks
#     MOBILE_KEYSTORE_PASSWORD=...
#     MOBILE_KEY_ALIAS=...
#     MOBILE_KEY_PASSWORD=...
#
# NEVER commit the .jks or that file. `.gitignore` already covers `*.jks`,
# `*.keystore` and `.env.mobile-signing`.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOBILE_DIR="$REPO_ROOT/apps/mobile"
SIGNING_ENV="$REPO_ROOT/.env.mobile-signing"

CLEAN_PREBUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-clean) CLEAN_PREBUILD=0 ;;
    -h | --help)
      sed -n '2,50p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

fail() {
  echo "" >&2
  echo "FAILED: $*" >&2
  exit 1
}

# Git Bash hands out MSYS paths (/c/projects/demli/…). node, java and gradle are all
# native Windows binaries that cannot resolve those, so anything crossing that
# boundary goes through cygpath.
to_native() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s' "$1"
  fi
}

# --- 1. signing credentials (checked FIRST — a 30-minute build that ends in an
#        unshippable APK is the worst possible failure mode) -------------------
[[ -f "$SIGNING_ENV" ]] || fail "$SIGNING_ENV missing.
  Create it with MOBILE_KEYSTORE_PATH / MOBILE_KEYSTORE_PASSWORD / MOBILE_KEY_ALIAS /
  MOBILE_KEY_PASSWORD — see the header of this script for how to get them from EAS."

set -a
# shellcheck disable=SC1090
. "$SIGNING_ENV"
set +a

: "${MOBILE_KEYSTORE_PATH:?Set MOBILE_KEYSTORE_PATH in .env.mobile-signing}"
: "${MOBILE_KEYSTORE_PASSWORD:?Set MOBILE_KEYSTORE_PASSWORD in .env.mobile-signing}"
: "${MOBILE_KEY_ALIAS:?Set MOBILE_KEY_ALIAS in .env.mobile-signing}"
: "${MOBILE_KEY_PASSWORD:?Set MOBILE_KEY_PASSWORD in .env.mobile-signing}"

# Resolve to an absolute path; gradle runs from apps/mobile/android.
case "$MOBILE_KEYSTORE_PATH" in
  /* | [A-Za-z]:*) KEYSTORE_ABS="$MOBILE_KEYSTORE_PATH" ;;
  *) KEYSTORE_ABS="$REPO_ROOT/$MOBILE_KEYSTORE_PATH" ;;
esac
if [[ ! -f "$KEYSTORE_ABS" ]]; then
  fail "keystore not found at $KEYSTORE_ABS
  Point MOBILE_KEYSTORE_PATH in .env.mobile-signing at the release keystore (the
  SAME key as the published builds — a new one means installed users can never
  update)."
fi
# gradle is a native Windows process — hand it a path it can open.
KEYSTORE_ABS="$(to_native "$KEYSTORE_ABS")"

# --- 2. path length (Windows MAX_PATH) --------------------------------------
# The NDK/CMake side of react-native-reanimated generates object-file paths ~195
# characters long RELATIVE to the repo root. Windows still caps a path at 260
# characters for the APIs ninja and CMake use, so once the repo root passes ~32
# characters the build dies with the useless
#     ninja: error: manifest 'build.ninja' still dirty after 100 tries
# after ten minutes of work — CMake keeps re-globbing because it cannot stat the
# files it just wrote. Measured 2026-07-27: from an 11-char repo root the longest
# path is 206 chars (fine); from an agent worktree under .claude/worktrees/<id>
# it is 248 and climbing past the limit with ninja's own .rsp/.d temporaries.
#
# So: build from the MAIN checkout, never from a git worktree.
#
# The threshold is empirical, not theoretical: an 11-char root builds, the
# 53-char worktree root does not. 32 leaves room for C:/projects/demli while
# staying far below the known-bad length.
MAX_ROOT_LEN=32
REPO_ROOT_NATIVE="$(to_native "$REPO_ROOT")"
ROOT_LEN=${#REPO_ROOT_NATIVE}
if [[ "$ROOT_LEN" -gt "$MAX_ROOT_LEN" ]]; then
  fail "the repo path is $ROOT_LEN characters:
    $REPO_ROOT_NATIVE
  The Android NDK build appends ~195 more and Windows caps paths at 260, so this
  build WILL fail ten minutes in with the unhelpful
    ninja: error: manifest 'build.ninja' still dirty after 100 tries
  Run it from the main checkout ($MAX_ROOT_LEN chars or fewer) rather than a git
  worktree — merge the branch first, then build."
fi

# --- 3. toolchain -----------------------------------------------------------
command -v java >/dev/null 2>&1 || fail "java not on PATH (JDK 17+ required)"

ANDROID_SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}}"
if [[ ! -d "$ANDROID_SDK" ]] && [[ -d "$HOME/AppData/Local/Android/Sdk" ]]; then
  ANDROID_SDK="$HOME/AppData/Local/Android/Sdk"
fi
[[ -d "$ANDROID_SDK" ]] || fail "Android SDK not found. Install it (Android Studio) or set ANDROID_SDK_ROOT."
export ANDROID_SDK_ROOT="$ANDROID_SDK"
export ANDROID_HOME="$ANDROID_SDK"

# --- 4. FCM config (required by the expo-notifications / google-services
#        gradle plugin at PREBUILD + BUILD time; never committed) -------------
GOOGLE_SERVICES_FILE="${GOOGLE_SERVICES_JSON:-$MOBILE_DIR/google-services.json}"
case "$GOOGLE_SERVICES_FILE" in
  /* | [A-Za-z]:*) ;;
  *) GOOGLE_SERVICES_FILE="$MOBILE_DIR/$GOOGLE_SERVICES_FILE" ;;
esac
# The package id this build ships as — read from app.json so the check below can
# never drift from the identity actually being built.
ANDROID_PACKAGE="$(sed -n 's/.*"package"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  "$MOBILE_DIR/app.json" | head -1)"
[[ -n "$ANDROID_PACKAGE" ]] || fail "could not read expo.android.package from $MOBILE_DIR/app.json"

[[ -f "$GOOGLE_SERVICES_FILE" ]] || fail "google-services.json not found at $GOOGLE_SERVICES_FILE.
  It is gitignored on purpose (FCM sender credentials). Copy it from the machine
  that has it, or download it from the Firebase console (Project settings ->
  Your apps -> Android app '$ANDROID_PACKAGE' -> google-services.json)."

# The FCM config is keyed BY PACKAGE ID, and a google-services.json that does not
# know this package is the quietest possible failure: the google-services gradle
# plugin does fail, but ~8 minutes into a native build with a message about a
# missing client — and if a future plugin version ever softened that to a warning,
# the APK would install fine and simply never receive a push. So assert it HERE,
# before a single gradle task runs.
if ! grep -q "\"package_name\"[[:space:]]*:[[:space:]]*\"$ANDROID_PACKAGE\"" "$GOOGLE_SERVICES_FILE"; then
  fail "google-services.json has no client for '$ANDROID_PACKAGE'.
    $GOOGLE_SERVICES_FILE
  FCM registrations are per-package. In the Firebase console: Project settings
  -> Your apps -> Add app -> Android, package name '$ANDROID_PACKAGE', then
  download the regenerated google-services.json and replace the file above.
  Building against a file without this client produces an APK that can never get
  a push."
fi

export GOOGLE_SERVICES_JSON="$(to_native "$GOOGLE_SERVICES_FILE")"

# --- 5. the SAME public config EAS bakes in for the `preview` profile --------
# eas.json injects these; a local gradle build gets NOTHING unless we set them.
# They are also the fallbacks in apps/mobile/src/lib/server-config.ts, so an
# unset build happens to work today — but a stray apps/mobile/.env with LAN URLs
# would silently produce an APK that talks to a dev machine. Be explicit.
export EXPO_PUBLIC_API_URL="${EXPO_PUBLIC_API_URL:-https://api.getdemli.com}"
export EXPO_PUBLIC_REALTIME_URL="${EXPO_PUBLIC_REALTIME_URL:-wss://ws.getdemli.com}"

APP_JSON_NATIVE="$(to_native "$MOBILE_DIR/app.json")"
read_app_json() { node -p "require('$APP_JSON_NATIVE').expo.$1"; }
APP_VERSION="$(read_app_json version)"
RUNTIME_VERSION="$(read_app_json runtimeVersion)"
VERSION_CODE="$(read_app_json android.versionCode)"
APP_NAME="$(read_app_json name)"

echo "== Demli Android release build =============================================="
echo "   app name       : $APP_NAME"
echo "   version        : $APP_VERSION (versionCode $VERSION_CODE)"
echo "   runtimeVersion : $RUNTIME_VERSION"
echo "   api / realtime : $EXPO_PUBLIC_API_URL  /  $EXPO_PUBLIC_REALTIME_URL"
echo "   keystore       : $KEYSTORE_ABS (alias $MOBILE_KEY_ALIAS)"
echo "   android sdk    : $ANDROID_SDK_ROOT"
echo "============================================================================"

# --- 6. prebuild — regenerates android/ from app.json + config plugins -------
# This is where the app NAME (strings.xml) and the ICONS (mipmap-*) are baked in
# from assets/. A stale android/ dir is exactly how a rebrand ships with the old
# launcher icon, so --clean is the default.
cd "$MOBILE_DIR"
if [[ "$CLEAN_PREBUILD" -eq 1 ]]; then
  echo "== expo prebuild --clean (regenerating android/ from app.json) =="
  npx expo prebuild --platform android --clean
else
  echo "== expo prebuild (incremental — android/ kept) =="
  npx expo prebuild --platform android
fi

# --- 7. verify the rebrand actually landed in the native project -------------
STRINGS_XML="$MOBILE_DIR/android/app/src/main/res/values/strings.xml"
[[ -f "$STRINGS_XML" ]] || fail "prebuild did not produce $STRINGS_XML"
if ! grep -q "\"app_name\">$APP_NAME<" "$STRINGS_XML"; then
  fail "android app_name is not '$APP_NAME' — check \`expo.name\` in app.json.
  Got: $(grep 'app_name' "$STRINGS_XML")"
fi
echo "== app_name in strings.xml = $APP_NAME  (ok) =="

# --- 8. gradle release build, signed with the real key -----------------------
# `android.injected.signing.*` is the standard mechanism (Android Studio and CI
# use it). It replaces the template's debug signingConfig for THIS invocation
# only, so nothing about the generated android/ dir has to be patched.
cd "$MOBILE_DIR/android"
echo "== gradlew assembleRelease (this takes a while) =="
./gradlew assembleRelease \
  --no-daemon \
  -Pandroid.injected.signing.store.file="$KEYSTORE_ABS" \
  -Pandroid.injected.signing.store.password="$MOBILE_KEYSTORE_PASSWORD" \
  -Pandroid.injected.signing.key.alias="$MOBILE_KEY_ALIAS" \
  -Pandroid.injected.signing.key.password="$MOBILE_KEY_PASSWORD"

APK="$MOBILE_DIR/android/app/build/outputs/apk/release/app-release.apk"
[[ -f "$APK" ]] || fail "gradle reported success but $APK is missing"

# --- 9. prove it is signed with the expected key -----------------------------
# An APK signed with the wrong key is unrecoverable for anyone who already has
# the app: Android refuses the update, and their only way out is to uninstall
# (losing local state) and reinstall. So this is a hard gate, not a nicety.
#
# It must therefore be impossible for this gate to SKIP silently. It did exactly
# that once (2026-07-28): `find … -name "apksigner*"` matched the JAR before the
# wrapper script, and running a .jar as a command dies with "cannot execute
# binary file". Both invocations failed, `|| true` and the `grep -qi` both
# swallowed it, and the build printed BUILD OK having verified nothing. Hence:
# prefer the wrapper, fall back to `java -jar`, and treat "could not verify" as
# a FAILURE rather than a warning.
APKSIGNER="$(find "$ANDROID_SDK_ROOT/build-tools" -name "apksigner" -o -name "apksigner.bat" -type f 2>/dev/null | sort -r | head -1)"
APKSIGNER_JAR="$(find "$ANDROID_SDK_ROOT/build-tools" -name "apksigner.jar" -type f 2>/dev/null | sort -r | head -1)"

run_apksigner() {
  if [[ -n "$APKSIGNER" && -x "$APKSIGNER" ]]; then
    "$APKSIGNER" "$@"
  elif [[ -n "$APKSIGNER_JAR" ]] && command -v java >/dev/null 2>&1; then
    java -jar "$APKSIGNER_JAR" "$@"
  else
    return 127
  fi
}

echo "== apksigner verify =="
if ! CERTS="$(run_apksigner verify --print-certs "$APK" 2>&1)"; then
  fail "could not verify the APK signature (apksigner unavailable or failed):
$CERTS
  Refusing to report success on an unverified APK — a wrongly signed one breaks
  updates permanently for every existing install."
fi
echo "$CERTS" | grep -iE "Signer #1 certificate (DN|SHA-256)" || true
if echo "$CERTS" | grep -qi "CN=Android Debug"; then
  fail "the APK is DEBUG-SIGNED. Publishing it would permanently break updates for
  everyone who installs it. Check MOBILE_KEYSTORE_* in .env.mobile-signing."
fi

# Beyond "not debug": prove it is THE key, by comparing the APK's certificate
# digest with the keystore's own. Same-shaped release keys are otherwise
# indistinguishable here, and picking up a different one is precisely the
# unrecoverable mistake above.
if command -v keytool >/dev/null 2>&1; then
  # Strip up to the FIRST colon, not the last. `s/.*: *//` is greedy, and keytool
  # prints the digest as colon-separated hex — so it swallowed the whole
  # fingerprint and left the final byte. The apksigner line carries one colon, so
  # it survived, and the gate then compared 64 characters against 2 and failed a
  # CORRECTLY signed APK. A gate that cries wolf is one somebody eventually
  # deletes, which is worse than never having written it.
  APK_SHA="$(echo "$CERTS" | grep -i "Signer #1 certificate SHA-256 digest" |
    sed 's/^[^:]*: *//' | tr -d ' :' | tr 'A-F' 'a-f')"
  STORE_SHA="$(keytool -list -v -keystore "$KEYSTORE_ABS" \
    -storepass "$MOBILE_KEYSTORE_PASSWORD" -alias "$MOBILE_KEY_ALIAS" 2>/dev/null |
    grep -i "SHA256:" | head -1 | sed 's/^[^:]*: *//' | tr -d ' :' | tr 'A-F' 'a-f')"
  # A SHA-256 is 64 hex characters. Anything shorter means the parse broke, and a
  # broken parse must stop the build rather than quietly compare two fragments.
  for _sha in "$APK_SHA" "$STORE_SHA"; do
    [[ ${#_sha} -eq 64 ]] || fail "could not read a full SHA-256 digest (got ${#_sha} chars).
  The signature check could not run, so this build is NOT verified."
  done
  if [[ -n "$APK_SHA" && -n "$STORE_SHA" ]]; then
    [[ "$APK_SHA" == "$STORE_SHA" ]] ||
      fail "the APK was signed with a DIFFERENT key than $MOBILE_KEYSTORE_PATH.
  apk:      $APK_SHA
  keystore: $STORE_SHA
  Publishing it would permanently break updates for every existing install."
    echo "   signature matches the keystore ($APK_SHA)"
  fi
fi

SIZE="$(wc -c < "$APK")"
echo ""
echo "== BUILD OK ================================================================"
echo "   $APK  ($SIZE bytes)"
echo ""
echo "   Next, IN THIS ORDER (deploying first would prompt every install to"
echo "   download an APK that is not on the server yet):"
echo "     1. bash scripts/publish-mobile-apk.sh \"$APK\""
echo "     2. bash scripts/deploy-remote.sh      # advertises runtime $RUNTIME_VERSION"
echo "============================================================================"
