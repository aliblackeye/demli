#!/usr/bin/env bash
# Publish a built desktop release to the electron-updater feed on the VPS.
#
# The desktop app auto-updates from https://api.<DOMAIN>/dl/desktop/ (Caddy
# serves /srv/demli-dl read-only). A release is, per platform:
#   windows: <channel>.yml, Demli-Setup-<ver>.exe, Demli-Setup-<ver>.exe.blockmap
#   macos:   <channel>-mac.yml, Demli-<ver>-<arch>.dmg, Demli-<ver>-<arch>.zip
#            (+ .blockmap side-cars)
# <channel> is read from apps/desktop/electron-builder.yml (`demli`).
#
# The artifact names come from `productName` in apps/desktop/electron-builder.yml.
# They are asserted against the Caddy /download/* redirect targets by
# `pnpm lint:caddy`, so a rename that misses one file fails the lint instead of
# 404ing the founder's download link in production.
# electron-updater reads the manifest, compares semver, then pulls the binary
# (+ blockmap for a delta download). Everything MUST land together or clients
# see a broken/half feed — hence: binaries first, manifest LAST.
#
# Credentials are NOT baked in — you supply the SSH target. Auth is auto-detected:
#   - PuTTY `pscp`/`plink` (Windows Git Bash) when DEPLOY_PASS is set, else
#   - `sshpass` scp/ssh (Linux/WSL) when DEPLOY_PASS is set, else
#   - an SSH key/agent (omit DEPLOY_PASS).
#
# Usage (from repo root):
#   DEPLOY_HOST=root@<vps-ip> ./scripts/publish-desktop.sh                       # windows (default)
#   DEPLOY_HOST=root@<vps-ip> ./scripts/publish-desktop.sh --mac                 # macOS only
#   DEPLOY_HOST=root@<vps-ip> ./scripts/publish-desktop.sh --all                 # both
#   DEPLOY_HOST=root@<vps-ip> DEPLOY_PASS='...' ./scripts/publish-desktop.sh     # password
#   DEPLOY_HOST=root@<vps-ip> VERSION=0.0.18 DEPLOY_PASS='...' ./scripts/publish-desktop.sh
#   DRY_RUN=1 ./scripts/publish-desktop.sh --all    # list what would upload, touch nothing
#
# NOTE: the default (no flag) is WINDOWS ONLY, byte-for-byte the behaviour this
# script has always had — the founder's live auto-update path. macOS publishing
# is strictly additive and opt-in.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- platform selection -----------------------------------------------------
PUBLISH_WIN=1
PUBLISH_MAC=0
for arg in "$@"; do
  case "$arg" in
    --win) PUBLISH_WIN=1; PUBLISH_MAC=0 ;;
    --mac) PUBLISH_WIN=0; PUBLISH_MAC=1 ;;
    --all) PUBLISH_WIN=1; PUBLISH_MAC=1 ;;
    *) echo "Unknown argument: $arg (expected --win | --mac | --all)" >&2; exit 2 ;;
  esac
done

# Load machine-local deploy credentials if present (.env.deploy is gitignored),
# so this runs as a bare `bash scripts/publish-desktop.sh` with no secret on the
# command line. Explicit env vars still win.
if [[ -f "$REPO_ROOT/.env.deploy" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env.deploy"
  set +a
fi

# Host-key pinning + password-off-argv, shared with every other remote script
# (security-review HIGH x2): the sshpass branches below used
# StrictHostKeyChecking=accept-new and `sshpass -p "$PASS"`.
# shellcheck source=lib/remote-ssh.sh
. "$REPO_ROOT/scripts/lib/remote-ssh.sh"

# Read the desktop app version WITHOUT node — a Windows node can't `require()` an
# MSYS "/c/…" path, so parse the first "version" field straight from package.json.
if [[ -z "${VERSION:-}" ]]; then
  VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$REPO_ROOT/apps/desktop/package.json" | head -1)"
fi
REL_DIR="$REPO_ROOT/apps/desktop/release/$VERSION"
REMOTE_DIR="/srv/demli-dl/desktop"

# --- update channel ---------------------------------------------------------
# electron-updater names its manifest after the channel: `latest` -> latest.yml,
# `demli` -> demli.yml (macOS: <channel>-mac.yml). READ from electron-builder.yml
# rather than hardcoded, so the manifest this script uploads can never disagree
# with the one the build produced — a mismatch uploads binaries under a manifest
# nobody reads and leaves the live one pointing at the previous release.
#
# This script only ever uploads the manifests it derives from that channel, so a
# manifest belonging to any other channel is left untouched by construction.
CHANNEL="$(sed -n 's/^[[:space:]]*channel:[[:space:]]*\([A-Za-z0-9._-][A-Za-z0-9._-]*\).*/\1/p' \
  "$REPO_ROOT/apps/desktop/electron-builder.yml" | head -1)"
if [[ -z "$CHANNEL" ]]; then
  echo "MISSING: no 'channel:' in apps/desktop/electron-builder.yml — cannot tell which manifest to publish." >&2
  exit 1
fi
WIN_MANIFEST="$CHANNEL.yml"
MAC_MANIFEST="$CHANNEL-mac.yml"
echo "== channel: $CHANNEL (manifests: $WIN_MANIFEST / $MAC_MANIFEST) =="

DRY_RUN="${DRY_RUN:-0}"

if [[ "$DRY_RUN" != "1" ]]; then
  # VPS SSH host-key fingerprint, so batch (non-interactive) auth never prompts.
  # REQUIRED, from the gitignored .env.deploy — deliberately not baked in, so this
  # repo can go public without publishing the server identity. Read it once with:
  #   ssh-keyscan -t ed25519 HOST | ssh-keygen -lf -   (or PuTTY on first connect)
  : "${DEPLOY_HOSTKEY:?Set DEPLOY_HOSTKEY (the VPS SSH host-key fingerprint) in .env.deploy}"
  : "${DEPLOY_HOST:?Set DEPLOY_HOST=user@host (the VPS SSH target)}"
else
  # DRY_RUN exits before any connection, so placeholders are enough — but they
  # must land in the same variables the shared lib reads, not a local alias.
  DEPLOY_HOSTKEY="${DEPLOY_HOSTKEY:-dry-run}"
  DEPLOY_HOST="${DEPLOY_HOST:-dry-run@localhost}"
fi

# --- collect the artifacts --------------------------------------------------
# `payload` = binaries + blockmaps (uploaded first).
# `manifests` = latest*.yml (uploaded LAST, so a client never reads a manifest
# whose binary isn't up yet).
payload=()
manifests=()

require_file() {
  local f="$1" hint="$2"
  if [[ ! -f "$REL_DIR/$f" ]]; then
    echo "MISSING: $REL_DIR/$f  — run '$hint' first" >&2
    exit 1
  fi
}

if [[ "$PUBLISH_WIN" == "1" ]]; then
  WIN_HINT="DEMLI_DOMAIN=<domain> pnpm --filter @demli/desktop package:win"
  SETUP="Demli-Setup-$VERSION.exe"
  require_file "$SETUP" "$WIN_HINT"
  require_file "$SETUP.blockmap" "$WIN_HINT"
  require_file "$WIN_MANIFEST" "$WIN_HINT"
  payload+=("$SETUP" "$SETUP.blockmap")
  manifests+=("$WIN_MANIFEST")
fi

if [[ "$PUBLISH_MAC" == "1" ]]; then
  # macOS ships per-arch dmg + zip. Glob rather than hardcode the arch list, so
  # a build that emits only arm64 (or adds universal later) still publishes.
  MAC_HINT="DEMLI_DOMAIN=<domain> pnpm --filter @demli/desktop package:mac  (macOS host, or the desktop-mac.yml GitHub Actions workflow)"
  mac_found=0
  for f in "$REL_DIR/Demli-$VERSION"-*.dmg "$REL_DIR/Demli-$VERSION"-*.zip \
           "$REL_DIR/Demli-$VERSION"-*.zip.blockmap; do
    [[ -f "$f" ]] || continue
    payload+=("$(basename "$f")")
    mac_found=1
  done
  if [[ "$mac_found" != "1" ]]; then
    echo "MISSING: no macOS artifacts in $REL_DIR (Demli-$VERSION-*.dmg/.zip)" >&2
    echo "  — run '$MAC_HINT' first, or download the workflow artifact into that folder." >&2
    exit 1
  fi
  # The zip is what Squirrel.Mac actually downloads; the mac manifest points at it.
  require_file "$MAC_MANIFEST" "$MAC_HINT"
  manifests+=("$MAC_MANIFEST")
fi

echo "== Publishing desktop $VERSION → $DEPLOY_HOST:$REMOTE_DIR =="
for f in "${payload[@]}" "${manifests[@]}"; do
  printf '  %-44s %s bytes\n' "$f" "$(wc -c < "$REL_DIR/$f")"
done

if [[ "$DRY_RUN" == "1" ]]; then
  echo "== DRY_RUN=1 — nothing uploaded, nothing verified =="
  exit 0
fi

# Upload from inside the release dir with RELATIVE names — the native Windows
# pscp.exe does not understand MSYS "/c/…" source paths.
cd "$REL_DIR"

# Run one shell command on the VPS, using whichever auth is available (same
# detection order as the uploads below). Every path is NON-INTERACTIVE: a publish
# must never stall on a hidden password prompt, so when password auth is asked
# for but no batch-capable client exists this fails instead of falling back to a
# bare `ssh`.
run_remote() { # $1 = shell command
  if [[ -n "${DEPLOY_PASS:-}" ]]; then
    if command -v plink >/dev/null 2>&1; then
      remote_putty_pw_args plink
      plink "${REMOTE_PUTTY_ARGS[@]}" "$DEPLOY_HOST" "$1"
    elif command -v sshpass >/dev/null 2>&1; then
      remote_ssh_opts
      remote_password_env
      sshpass -e ssh "${REMOTE_SSH_OPTS[@]}" "$DEPLOY_HOST" "$1"
    else
      return 1
    fi
  else
    remote_ssh_opts
    ssh -o BatchMode=yes "${REMOTE_SSH_OPTS[@]}" "$DEPLOY_HOST" "$1"
  fi
}

if [[ -n "${DEPLOY_PASS:-}" ]] && command -v pscp >/dev/null 2>&1; then
  echo "== auth: PuTTY pscp (password, pinned host key) =="
  remote_putty_pw_args pscp
  if command -v plink >/dev/null 2>&1; then
    run_remote "install -d '$REMOTE_DIR'" || true
  fi
  pscp "${REMOTE_PUTTY_ARGS[@]}" "${payload[@]}" "$DEPLOY_HOST:$REMOTE_DIR/"
  pscp "${REMOTE_PUTTY_ARGS[@]}" "${manifests[@]}" "$DEPLOY_HOST:$REMOTE_DIR/"
elif [[ -n "${DEPLOY_PASS:-}" ]] && command -v sshpass >/dev/null 2>&1; then
  echo "== auth: sshpass scp (password, pinned host key) =="
  remote_scp_opts
  remote_password_env
  run_remote "install -d '$REMOTE_DIR'"
  sshpass -e scp "${REMOTE_SCP_OPTS[@]}" "${payload[@]}" "$DEPLOY_HOST:$REMOTE_DIR/"
  sshpass -e scp "${REMOTE_SCP_OPTS[@]}" "${manifests[@]}" "$DEPLOY_HOST:$REMOTE_DIR/"
elif [[ -n "${DEPLOY_PASS:-}" ]]; then
  echo "DEPLOY_PASS set but neither 'pscp' (PuTTY) nor 'sshpass' is installed." >&2
  echo "Install PuTTY, or use SSH key auth (omit DEPLOY_PASS)." >&2
  exit 1
else
  echo "== auth: SSH key/agent (pinned host key) =="
  remote_scp_opts
  run_remote "install -d '$REMOTE_DIR'"
  scp "${REMOTE_SCP_OPTS[@]}" "${payload[@]}" "$DEPLOY_HOST:$REMOTE_DIR/"
  scp "${REMOTE_SCP_OPTS[@]}" "${manifests[@]}" "$DEPLOY_HOST:$REMOTE_DIR/"
fi

# --- stable, version-independent download aliases ----------------------------
# The landing page links https://<domain>/download/{windows,macos}, which Caddy
# redirects to /dl/desktop/Demli-Setup.exe and /dl/desktop/Demli-macos.dmg —
# RELATIVE symlinks next to the versioned artifacts, re-pointed here on every
# publish so the links never go stale. electron-updater is unaffected: it reads
# the VERSIONED names from the channel manifests instead.
# Non-fatal — a failed alias must not make a successful publish look broken.
if [[ "$PUBLISH_WIN" == "1" ]]; then
  echo "== Refreshing stable installer alias (Demli-Setup.exe -> $SETUP) =="
  if run_remote "ln -sfn '$SETUP' '$REMOTE_DIR/Demli-Setup.exe'"; then
    echo "   ok"
  else
    echo "WARN: could not refresh $REMOTE_DIR/Demli-Setup.exe — /download/windows may serve the previous build." >&2
  fi
fi

if [[ "$PUBLISH_MAC" == "1" ]]; then
  # Prefer Apple Silicon: it is the overwhelming majority of Macs in use and an
  # arm64 dmg refuses to run on Intel, whereas the x64 build runs everywhere via
  # Rosetta. Fall back to whatever single dmg exists if only one arch was built.
  MAC_DMG=""
  for candidate in "Demli-$VERSION-arm64.dmg" "Demli-$VERSION-x64.dmg"; do
    if [[ -f "$REL_DIR/$candidate" ]]; then
      MAC_DMG="$candidate"
      break
    fi
  done
  if [[ -z "$MAC_DMG" ]]; then
    for f in "$REL_DIR/Demli-$VERSION"-*.dmg; do
      [[ -f "$f" ]] && MAC_DMG="$(basename "$f")" && break
    done
  fi
  if [[ -n "$MAC_DMG" ]]; then
    echo "== Refreshing stable macOS alias (Demli-macos.dmg -> $MAC_DMG) =="
    if run_remote "ln -sfn '$MAC_DMG' '$REMOTE_DIR/Demli-macos.dmg'"; then
      echo "   ok"
    else
      echo "WARN: could not refresh $REMOTE_DIR/Demli-macos.dmg — /download/macos may 404." >&2
    fi
  fi
fi

echo "== Verifying feed =="
DOMAIN="${DEMLI_DOMAIN:-getdemli.com}"
for m in "${manifests[@]}"; do
  echo "-- $m"
  curl -fsS "https://api.$DOMAIN/dl/desktop/$m" | sed -n '1,3p'
done
if [[ "$PUBLISH_WIN" == "1" ]]; then
  echo "-- Demli-Setup.exe (stable alias behind /download/windows)"
  curl -fsSI "https://api.$DOMAIN/dl/desktop/Demli-Setup.exe" \
    | grep -iE "HTTP/|Content-Length" | head -2 \
    || echo "WARN: the stable alias did not resolve — check the symlink on the VPS." >&2
fi
if [[ "$PUBLISH_MAC" == "1" ]]; then
  echo "-- Demli-macos.dmg (stable alias behind /download/macos)"
  curl -fsSI "https://api.$DOMAIN/dl/desktop/Demli-macos.dmg" \
    | grep -iE "HTTP/|Content-Length" | head -2 \
    || echo "WARN: the stable macOS alias did not resolve — check the symlink on the VPS." >&2
fi
echo "OK — desktop $VERSION live at https://api.$DOMAIN/dl/desktop/"
