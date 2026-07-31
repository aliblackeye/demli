#!/usr/bin/env bash
# Publish a built Android APK to the fixed mobile download link on the VPS.
#
# The in-app native self-updater (task #59) downloads the APK from the fixed
# link https://api.<DOMAIN>/dl/mobile/demli.apk (Caddy serves /srv/demli-dl
# read-only) and installs it OVER the current app — which ONLY succeeds when the
# APK is signed with the SAME key as the installed app. Normally the EAS build
# webhook (task #39) writes this file; this script is the manual path for a
# locally-built + EAS-key-RESIGNED APK (EAS free-tier build quota exhausted) —
# see scripts/build-mobile-apk.sh, which ends by telling you to run this.
#
# The filename `demli.apk` is shared with the Caddy /download/android redirect,
# the MOBILE_APK_URL default in apps/api/src/env.ts and FINAL_NAME in
# apps/api/src/modules/hooks/download.ts. They must change together or the
# download link 404s; scripts/check-caddyfile.mjs ("apk-alias") enforces that.
#
# Credentials come from the gitignored .env.deploy (DEPLOY_HOST, DEPLOY_PASS),
# same as publish-desktop.sh. Auth auto-detects PuTTY pscp/plink or sshpass.
#
# Usage (from repo root):
#   bash scripts/publish-mobile-apk.sh <path-to.apk>
#   bash scripts/publish-mobile-apk.sh apps/mobile/android/app/build/outputs/apk/release/app-release-signed.apk
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$REPO_ROOT/.env.deploy" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env.deploy"
  set +a
fi

APK_SRC="${1:?Usage: bash scripts/publish-mobile-apk.sh <path-to.apk>}"
[[ -f "$APK_SRC" ]] || { echo "MISSING: $APK_SRC" >&2; exit 1; }

# Host-key pinning + password-off-argv for every auth branch (security-review
# HIGH x2). This script had BOTH holes: `sshpass -p "$DEPLOY_PASS"` (password in
# argv) and `-o StrictHostKeyChecking=accept-new` (host key ignored).
# shellcheck source=lib/remote-ssh.sh
. "$REPO_ROOT/scripts/lib/remote-ssh.sh"

REMOTE_DIR="/srv/demli-dl/mobile"
REMOTE_NAME="demli.apk"   # the fixed link the self-updater fetches
: "${DEPLOY_HOSTKEY:?Set DEPLOY_HOSTKEY (the VPS SSH host-key fingerprint) in .env.deploy}"
: "${DEPLOY_HOST:?Set DEPLOY_HOST=user@host in .env.deploy}"

# pscp cannot read MSYS "/c/…" source paths, so upload from the APK's own dir with
# a RELATIVE name, then rename to demli.apk on the server (atomic-ish move so a
# client never fetches a half-uploaded file).
APK_DIR="$(cd "$(dirname "$APK_SRC")" && pwd)"
APK_BASE="$(basename "$APK_SRC")"
TMP_NAME="demli.apk.upload"
SIZE="$(wc -c < "$APK_SRC")"
echo "== Publishing mobile APK ($SIZE bytes) → $DEPLOY_HOST:$REMOTE_DIR/$REMOTE_NAME =="
cd "$APK_DIR"

run_remote() { # $1 = shell command on the VPS
  if command -v plink >/dev/null 2>&1 && [[ -n "${DEPLOY_PASS:-}" ]]; then
    remote_putty_pw_args plink
    plink "${REMOTE_PUTTY_ARGS[@]}" "$DEPLOY_HOST" "$1"
  elif command -v sshpass >/dev/null 2>&1 && [[ -n "${DEPLOY_PASS:-}" ]]; then
    remote_ssh_opts
    remote_password_env
    sshpass -e ssh "${REMOTE_SSH_OPTS[@]}" "$DEPLOY_HOST" "$1"
  else
    remote_ssh_opts
    ssh "${REMOTE_SSH_OPTS[@]}" "$DEPLOY_HOST" "$1"
  fi
}

if [[ -n "${DEPLOY_PASS:-}" ]] && command -v pscp >/dev/null 2>&1; then
  echo "== auth: PuTTY pscp (password, pinned host key) =="
  remote_putty_pw_args pscp
  run_remote "install -d '$REMOTE_DIR'" || true
  pscp "${REMOTE_PUTTY_ARGS[@]}" "$APK_BASE" "$DEPLOY_HOST:$REMOTE_DIR/$TMP_NAME"
  run_remote "mv -f '$REMOTE_DIR/$TMP_NAME' '$REMOTE_DIR/$REMOTE_NAME' && chmod 644 '$REMOTE_DIR/$REMOTE_NAME'"
elif [[ -n "${DEPLOY_PASS:-}" ]] && command -v sshpass >/dev/null 2>&1; then
  echo "== auth: sshpass scp (password, pinned host key) =="
  remote_scp_opts
  remote_password_env
  run_remote "install -d '$REMOTE_DIR'"
  sshpass -e scp "${REMOTE_SCP_OPTS[@]}" "$APK_BASE" "$DEPLOY_HOST:$REMOTE_DIR/$TMP_NAME"
  run_remote "mv -f '$REMOTE_DIR/$TMP_NAME' '$REMOTE_DIR/$REMOTE_NAME' && chmod 644 '$REMOTE_DIR/$REMOTE_NAME'"
else
  echo "== auth: SSH key/agent (pinned host key) =="
  remote_scp_opts
  run_remote "install -d '$REMOTE_DIR'"
  scp "${REMOTE_SCP_OPTS[@]}" "$APK_BASE" "$DEPLOY_HOST:$REMOTE_DIR/$TMP_NAME"
  run_remote "mv -f '$REMOTE_DIR/$TMP_NAME' '$REMOTE_DIR/$REMOTE_NAME' && chmod 644 '$REMOTE_DIR/$REMOTE_NAME'"
fi

echo "== Verifying link =="
DOMAIN="${DEMLI_DOMAIN:-getdemli.com}"
curl -fsSI "https://api.$DOMAIN/dl/mobile/$REMOTE_NAME" | grep -iE "HTTP/|Content-Length" | head -2
echo "OK — mobile APK live at https://api.$DOMAIN/dl/mobile/$REMOTE_NAME"
