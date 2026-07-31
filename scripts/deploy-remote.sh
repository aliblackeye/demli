#!/usr/bin/env bash
# Trigger a production deploy on the VPS from your workstation.
#
# It SSHes in, fast-forwards the checkout to origin/dev, and runs the on-VPS
# scripts/deploy.sh (render LiveKit config → build images → run migrations →
# refresh the stack → health check). Idempotent and safe to re-run.
#
# The desktop feed + mobile OTA ship separately (publish-desktop.sh / eas update);
# this only redeploys the server side (api, realtime, livekit, caddy, …).
#
# Auth auto-detected like publish-desktop.sh: PuTTY plink when DEPLOY_PASS is set
# (Windows Git Bash), else sshpass ssh (Linux/WSL), else an SSH key/agent.
#
# Usage (from repo root):
#   DEPLOY_HOST=root@<vps-ip> ./scripts/deploy-remote.sh                    # key/agent
#   DEPLOY_HOST=root@<vps-ip> DEPLOY_PASS='...' ./scripts/deploy-remote.sh  # password
#   DEPLOY_HOST=root@<vps-ip> DEPLOY_REF=origin/dev ./scripts/deploy-remote.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load machine-local deploy credentials if present (.env.deploy is gitignored),
# so the deploy can run as a bare `bash scripts/deploy-remote.sh` with no secret
# on the command line. Explicit env vars still win.
if [[ -f "$REPO_ROOT/.env.deploy" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env.deploy"
  set +a
fi

# Host-key pinning + password-off-argv for every auth branch (security-review
# HIGH x2). The sshpass branch below used to pass -o StrictHostKeyChecking=
# accept-new, which trusted whatever answered and then handed it the root
# password and a `git reset --hard && bash scripts/deploy.sh`.
# shellcheck source=lib/remote-ssh.sh
. "$REPO_ROOT/scripts/lib/remote-ssh.sh"

: "${DEPLOY_HOST:?Set DEPLOY_HOST=user@host (the VPS SSH target), or put it in .env.deploy}"
REMOTE_DIR="${REMOTE_DIR:-/opt/demli}"
DEPLOY_REF="${DEPLOY_REF:-origin/dev}"
# Assert the pin is present up front (the library re-reads DEPLOY_HOSTKEY itself)
# so a missing fingerprint fails before anything is printed about deploying.
: "${DEPLOY_HOSTKEY:?Set DEPLOY_HOSTKEY (the VPS SSH host-key fingerprint) in .env.deploy}"

# The remote command: sync the checkout to the deploy ref, then run the on-VPS
# deploy. `deploy.sh` itself does NO git — this is where the ref is chosen.
REMOTE_CMD="set -e; cd '$REMOTE_DIR'; git fetch origin --quiet; git reset --hard '$DEPLOY_REF'; echo '== checkout now' \$(git rev-parse --short HEAD) '=='; bash scripts/deploy.sh"

echo "== Deploying $DEPLOY_REF → $DEPLOY_HOST:$REMOTE_DIR =="

if [[ -n "${DEPLOY_PASS:-}" ]] && command -v plink >/dev/null 2>&1; then
  echo "== auth: PuTTY plink (password) =="
  remote_putty_pw_args plink
  plink "${REMOTE_PUTTY_ARGS[@]}" "$DEPLOY_HOST" "$REMOTE_CMD"
elif [[ -n "${DEPLOY_PASS:-}" ]] && command -v sshpass >/dev/null 2>&1; then
  echo "== auth: sshpass ssh (password, pinned host key) =="
  remote_ssh_opts
  remote_password_env
  sshpass -e ssh "${REMOTE_SSH_OPTS[@]}" "$DEPLOY_HOST" "$REMOTE_CMD"
elif [[ -n "${DEPLOY_PASS:-}" ]]; then
  echo "DEPLOY_PASS set but neither 'plink' (PuTTY) nor 'sshpass' is installed." >&2
  exit 1
else
  echo "== auth: SSH key/agent (pinned host key) =="
  remote_ssh_opts
  ssh "${REMOTE_SSH_OPTS[@]}" "$DEPLOY_HOST" "$REMOTE_CMD"
fi

echo ""
echo "== Verifying prod health =="
DOMAIN="${DEMLI_DOMAIN:-getdemli.com}"
curl -fsS "https://api.$DOMAIN/health" && echo "" && echo "OK — server redeployed."
