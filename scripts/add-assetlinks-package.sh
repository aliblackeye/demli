#!/usr/bin/env bash
# Add an Android package to the live App Links verification file.
#
# WHY THIS IS A SCRIPT AND NOT A COMMITTED FILE
# ---------------------------------------------
# `assetlinks.json` is NOT in this repo. It lives only on the VPS at
# /srv/dl/link/assetlinks.json (bind-mounted, served by Caddy at
# https://app.<DOMAIN>/.well-known/assetlinks.json) because its content is a
# signing-certificate SHA-256 — a fact about the keystore, not about the source
# tree. Committing a copy would mean committing a digest that could drift from
# the key that actually signs the APK, and a WRONG digest silently un-verifies
# every deep link on every device.
#
# So this script does the one edit that is actually needed and nothing else: it
# reads the LIVE file, appends a statement for the new package name REUSING THE
# EXISTING FINGERPRINTS (the migration keeps the same keystore — the package id
# changes, the signing key does not), and writes it back. The old package's
# statement is left in place: assetlinks is a LIST, and old installs keep their
# links working until they are gone.
#
# Without this, the new-identity app's App Links auto-verification fails and
# invite/friend links open the browser instead of the app. Not data loss — but
# invisible until a user reports it, which is exactly the class of thing that
# gets forgotten on a fresh server.
#
# Idempotent: re-running when the package is already listed changes nothing.
#
# Usage (from repo root, credentials come from .env.deploy like deploy-remote.sh):
#   bash scripts/add-assetlinks-package.sh                       # app.demli.mobile
#   bash scripts/add-assetlinks-package.sh com.example.other     # explicit package
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$REPO_ROOT/.env.deploy" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env.deploy"
  set +a
fi

NEW_PACKAGE="${1:-app.demli.mobile}"
DOMAIN="${DEMLI_DOMAIN:-getdemli.com}"
LINK_FILE="${LINK_FILE:-/srv/dl/link/assetlinks.json}"
PUBLIC_URL="https://app.${DOMAIN}/.well-known/assetlinks.json"

: "${DEPLOY_HOST:?Set DEPLOY_HOST=user@host (the VPS SSH target), or put it in .env.deploy}"
: "${DEPLOY_HOSTKEY:?Set DEPLOY_HOSTKEY (the VPS SSH host-key fingerprint) in .env.deploy}"

# Host-key pinning + password-off-argv (security-review HIGH x2): the sshpass
# branch below used StrictHostKeyChecking=accept-new and threw the pin away.
# shellcheck source=lib/remote-ssh.sh
. "$REPO_ROOT/scripts/lib/remote-ssh.sh"

# Run one command on the VPS with whichever auth this machine has, exactly like
# deploy-remote.sh (plink on Windows/Git Bash, sshpass on Linux/WSL, else key).
remote() {
  local cmd="$1"
  if [[ -n "${DEPLOY_PASS:-}" ]] && command -v plink >/dev/null 2>&1; then
    remote_putty_pw_args plink
    plink "${REMOTE_PUTTY_ARGS[@]}" "$DEPLOY_HOST" "$cmd"
  elif [[ -n "${DEPLOY_PASS:-}" ]] && command -v sshpass >/dev/null 2>&1; then
    remote_ssh_opts
    remote_password_env
    sshpass -e ssh "${REMOTE_SSH_OPTS[@]}" "$DEPLOY_HOST" "$cmd"
  elif [[ -n "${DEPLOY_PASS:-}" ]]; then
    echo "DEPLOY_PASS set but neither 'plink' (PuTTY) nor 'sshpass' is installed." >&2
    exit 1
  else
    remote_ssh_opts
    ssh "${REMOTE_SSH_OPTS[@]}" "$DEPLOY_HOST" "$cmd"
  fi
}

echo "== Reading the live App Links file: $PUBLIC_URL"
CURRENT="$(curl -fsS "$PUBLIC_URL")" || {
  echo "Could not read $PUBLIC_URL — is the file present at $LINK_FILE on the VPS?" >&2
  exit 1
}

if grep -q "\"$NEW_PACKAGE\"" <<<"$CURRENT"; then
  echo "== $NEW_PACKAGE is already listed — nothing to do."
  exit 0
fi

# The transform runs LOCALLY (node is on the dev machine; assuming a JSON tool on
# the VPS is a portability bet with no upside). It fails loudly rather than
# guessing whenever the input is not the shape it expects.
UPDATED="$(NEW_PACKAGE="$NEW_PACKAGE" node -e '
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => {
    const pkg = process.env.NEW_PACKAGE;
    const statements = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(statements)) throw new Error("assetlinks.json is not a JSON array");

    const targets = statements
      .map((s) => s && s.target)
      .filter((t) => t && t.namespace === "android_app");
    if (targets.length === 0) throw new Error("no android_app statement to copy fingerprints from");

    if (targets.some((t) => t.package_name === pkg)) {
      process.stderr.write("already-present\n");
      process.stdout.write(JSON.stringify(statements, null, 2) + "\n");
      return;
    }

    // Same keystore ⇒ same digest. Take it from the existing statement rather
    // than accepting one as an argument: a hand-typed digest is the one thing
    // here that can be silently wrong.
    const fingerprints = targets[0].sha256_cert_fingerprints;
    if (!Array.isArray(fingerprints) || fingerprints.length === 0) {
      throw new Error("existing android_app statement has no sha256_cert_fingerprints");
    }

    statements.push({
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: pkg,
        sha256_cert_fingerprints: [...fingerprints],
      },
    });
    process.stdout.write(JSON.stringify(statements, null, 2) + "\n");
  });
' <<<"$CURRENT")"

echo "== Adding package_name $NEW_PACKAGE (reusing the existing cert fingerprints)"

# base64 so the payload crosses the remote shell as one quoting-safe token.
PAYLOAD="$(printf '%s' "$UPDATED" | base64 | tr -d '\r\n')"
STAMP="$(date +%Y%m%d%H%M%S)"

remote "set -e; \
  cp '$LINK_FILE' '$LINK_FILE.bak.$STAMP'; \
  printf '%s' '$PAYLOAD' | base64 -d > '$LINK_FILE.new'; \
  node -e 'JSON.parse(require(\"fs\").readFileSync(\"$LINK_FILE.new\",\"utf8\"))' 2>/dev/null \
    || python3 -c 'import json,sys; json.load(open(\"$LINK_FILE.new\"))'; \
  mv '$LINK_FILE.new' '$LINK_FILE'; \
  chmod 644 '$LINK_FILE'; \
  echo 'backup: $LINK_FILE.bak.$STAMP'"

echo ""
echo "== Verifying the live file"
LIVE="$(curl -fsS "$PUBLIC_URL")"
if grep -q "\"$NEW_PACKAGE\"" <<<"$LIVE"; then
  echo "OK — $NEW_PACKAGE is served at $PUBLIC_URL"
else
  echo "FAILED — $NEW_PACKAGE is not in the served file. Restore: $LINK_FILE.bak.$STAMP" >&2
  exit 1
fi
