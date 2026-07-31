#!/usr/bin/env bash
# Build and publish the landing site (apps/landing) to the VPS static host.
#
# Caddy serves /srv/demli-landing read-only at https://<DOMAIN> — the apex
# {$DOMAIN} block in Caddyfile. Unlike the web app this is NOT an SPA:
# there is no index.html fallback, so the build must emit a real file for every
# routable path.
#
# Files are uploaded IN PLACE into the bind-mounted dir (Docker bind mounts track
# the directory inode, so a mv-swap would NOT update what Caddy serves). Old
# hashed /assets/* are intentionally left behind so a client still holding the
# previous index.html can fetch its chunks during rollout; prune them manually if
# they ever accumulate.
#
# Credentials are NOT baked in — you supply the SSH target. Auth is auto-detected:
#   - PuTTY `pscp`/`plink` (Windows Git Bash) when DEPLOY_PASS is set, else
#   - `sshpass` scp/ssh (Linux/WSL) when DEPLOY_PASS is set, else
#   - an SSH key/agent (omit DEPLOY_PASS).
#
# Usage (from repo root):
#   bash scripts/publish-landing.sh                      # build + upload + verify
#   SKIP_BUILD=1 bash scripts/publish-landing.sh         # reuse an existing build
#   DRY_RUN=1 bash scripts/publish-landing.sh            # resolve + list, upload nothing
#   DEMLI_DOMAIN=getdemli.com bash scripts/publish-landing.sh
#   LANDING_DIST=apps/landing/out bash scripts/publish-landing.sh   # pin the output dir
#
# The landing makes no API/WS/Supabase calls (its CSP forbids them), so there is
# nothing to keep in lockstep with the backend domain — unlike publish-web.sh.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load machine-local deploy credentials if present (.env.deploy is gitignored),
# so this runs as a bare `bash scripts/publish-landing.sh` with no secret on the
# command line. Explicit env vars still win.
if [[ -f "$REPO_ROOT/.env.deploy" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env.deploy"
  set +a
fi

# Host-key pinning + password-off-argv for every auth branch (security-review
# HIGH x2). The sshpass branch below used StrictHostKeyChecking=accept-new,
# which silently discarded the DEPLOY_HOSTKEY this script insists on.
# shellcheck source=lib/remote-ssh.sh
. "$REPO_ROOT/scripts/lib/remote-ssh.sh"

# The apex host the landing is served from. Same variable the other publish
# scripts use, so one .env.deploy line drives every channel.
DOMAIN="${DEMLI_DOMAIN:-getdemli.com}"
PACKAGE="${LANDING_PACKAGE:-@demli/landing}"
REMOTE_DIR="/srv/demli-landing"
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

if [[ ! -d "$REPO_ROOT/apps/landing" ]]; then
  echo "MISSING: $REPO_ROOT/apps/landing — the landing app has not landed yet." >&2
  exit 1
fi

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "== Building $PACKAGE =="
  ( cd "$REPO_ROOT" && pnpm --filter "$PACKAGE" build )
fi

# Resolve the build output. LANDING_DIST wins; otherwise probe the conventional
# output dirs (Vite `dist`, Next static export `out`, CRA/SvelteKit `build`) so
# this script does not have to be edited when apps/landing picks its toolchain.
if [[ -n "${LANDING_DIST:-}" ]]; then
  DIST_DIR="$REPO_ROOT/${LANDING_DIST#"$REPO_ROOT/"}"
else
  DIST_DIR=""
  for candidate in dist out build; do
    if [[ -f "$REPO_ROOT/apps/landing/$candidate/index.html" ]]; then
      DIST_DIR="$REPO_ROOT/apps/landing/$candidate"
      break
    fi
  done
fi

if [[ -z "$DIST_DIR" || ! -f "$DIST_DIR/index.html" ]]; then
  echo "MISSING: no landing build with an index.html." >&2
  echo "  Looked in: apps/landing/{dist,out,build}${LANDING_DIST:+ and $LANDING_DIST}" >&2
  echo "  Run without SKIP_BUILD, or set LANDING_DIST to the build output dir." >&2
  exit 1
fi

echo "== Publishing landing → $DEPLOY_HOST:$REMOTE_DIR =="
echo "   source: $DIST_DIR"
printf '  %-28s %s bytes\n' "index.html" "$(wc -c < "$DIST_DIR/index.html")"
[[ -d "$DIST_DIR/assets" ]] && printf '  %-28s %s files\n' "assets/" "$(find "$DIST_DIR/assets" -type f | wc -l)"
printf '  %-28s %s files\n' "total" "$(find "$DIST_DIR" -type f | wc -l)"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "== DRY_RUN=1 — nothing uploaded, nothing verified =="
  exit 0
fi

# Upload from inside the build dir with RELATIVE names — the native Windows
# pscp.exe does not understand MSYS "/c/…" source paths. `-r` recurses into
# assets/. Files land in place, merging with (and overwriting) the existing tree.
cd "$DIST_DIR"

if [[ -n "${DEPLOY_PASS:-}" ]] && command -v pscp >/dev/null 2>&1; then
  echo "== auth: PuTTY pscp (password, pinned host key) =="
  remote_putty_pw_args pscp
  if command -v plink >/dev/null 2>&1; then
    plink "${REMOTE_PUTTY_ARGS[@]}" "$DEPLOY_HOST" "install -d '$REMOTE_DIR'" || true
  fi
  pscp -r "${REMOTE_PUTTY_ARGS[@]}" * "$DEPLOY_HOST:$REMOTE_DIR/"
elif [[ -n "${DEPLOY_PASS:-}" ]] && command -v sshpass >/dev/null 2>&1; then
  echo "== auth: sshpass scp (password, pinned host key) =="
  remote_scp_opts
  remote_password_env
  sshpass -e ssh "${REMOTE_SSH_OPTS[@]}" "$DEPLOY_HOST" "install -d '$REMOTE_DIR'"
  sshpass -e scp -r "${REMOTE_SCP_OPTS[@]}" * "$DEPLOY_HOST:$REMOTE_DIR/"
elif [[ -n "${DEPLOY_PASS:-}" ]]; then
  echo "DEPLOY_PASS set but neither 'pscp' (PuTTY) nor 'sshpass' is installed." >&2
  echo "Install PuTTY, or use SSH key auth (omit DEPLOY_PASS)." >&2
  exit 1
else
  echo "== auth: SSH key/agent (pinned host key) =="
  remote_scp_opts
  ssh "${REMOTE_SSH_OPTS[@]}" "$DEPLOY_HOST" "install -d '$REMOTE_DIR'"
  scp -r "${REMOTE_SCP_OPTS[@]}" * "$DEPLOY_HOST:$REMOTE_DIR/"
fi

echo "== Verifying https://$DOMAIN =="
# -I HEAD first (status line), then confirm real HTML actually comes back.
curl -fsS -I "https://$DOMAIN" | sed -n '1,6p'
if curl -fsS "https://$DOMAIN" | grep -qi '<html'; then
  echo "OK — landing live at https://$DOMAIN"
else
  echo "WARN: served response was not HTML — check the deploy." >&2
  exit 1
fi

# The download links the landing page points at. All are redirects served by
# the same vhost; a 302 with a Location header is the pass condition.
#
# macOS is listed but NOT enforced: the redirect always answers 302, while its
# TARGET (the Demli-macos.dmg alias) only exists once a macOS build has been
# published. Until then the link 404s at the end of the hop — which is why the
# landing page must not surface a macOS download button yet (CLAUDE.md §35).
# `ios` is deliberately absent: there is no App Store listing, so that path
# answers an honest 404 by design.
echo "== Verifying download redirects =="
for target in windows android macos; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/download/$target")"
  loc="$(curl -sI "https://$DOMAIN/download/$target" | grep -i '^location:' | tr -d '\r' || true)"
  final="$(curl -s -o /dev/null -w '%{http_code}' -L "https://$DOMAIN/download/$target")"
  printf '  /download/%-8s %s -> %s %s\n' "$target" "$code" "$final" "${loc:-(no Location)}"
  if [[ "$code" != "302" ]]; then
    echo "WARN: /download/$target did not redirect (got $code)." >&2
  elif [[ "$final" != "200" && "$target" != "macos" ]]; then
    echo "WARN: /download/$target redirects to a target that answers $final." >&2
  fi
done
