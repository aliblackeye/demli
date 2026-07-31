#!/usr/bin/env bash
# Trigger the macOS desktop build on GitHub Actions and bring the artifacts home.
#
# macOS binaries can only be produced on macOS and the dev machine is Windows,
# so .github/workflows/desktop-mac.yml runs apps/desktop/scripts/package.mjs on a
# `macos-latest` runner. That workflow is manual (workflow_dispatch); this script
# is the one command that drives it end to end:
#
#   1. dispatch the workflow for a ref + DEMLI_DOMAIN
#   2. wait for the run to finish, printing its URL
#   3. download the artifact zip and unpack it into
#      apps/desktop/release/<version>/ — exactly where
#      `scripts/publish-desktop.sh --mac` expects to find it
#
# So a full macOS release is:
#   bash scripts/build-desktop-mac.sh
#   bash scripts/publish-desktop.sh --mac
#
# PREREQUISITES
#   - GITHUB_TOKEN in the gitignored .env.deploy (or the environment), a
#     fine-grained PAT with "Actions: read and write" on this repository. No
#     token is baked in, and none is ever printed.
#   - The workflow file must exist on the repository's DEFAULT branch. GitHub
#     only exposes workflow_dispatch for workflows present there, even when you
#     dispatch a different ref — if this script reports HTTP 404 on dispatch,
#     that is almost certainly why (merge dev -> master, or make dev the default
#     branch in the repo settings).
#
# COST: GitHub-hosted macOS runners are billed at 10x minutes on PRIVATE
# repositories and are free on public ones. Check the account's budget before
# running this on a private repo.
#
# Usage (from repo root):
#   bash scripts/build-desktop-mac.sh                    # current branch, getdemli.com
#   REF=dev bash scripts/build-desktop-mac.sh
#   DEMLI_DOMAIN=example.com bash scripts/build-desktop-mac.sh
#   NO_WAIT=1 bash scripts/build-desktop-mac.sh          # dispatch and exit
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Machine-local credentials (.env.deploy is gitignored). Explicit env vars win.
if [[ -f "$REPO_ROOT/.env.deploy" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env.deploy"
  set +a
fi

TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
if [[ -z "$TOKEN" ]]; then
  echo "GITHUB_TOKEN is not set. Add it to .env.deploy (fine-grained PAT, Actions: read and write)." >&2
  exit 1
fi

WORKFLOW="desktop-mac.yml"
DOMAIN="${DEMLI_DOMAIN:-getdemli.com}"
REF="${REF:-$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)}"

# owner/repo from the origin remote, so a fork or rename needs no edit here.
if [[ -z "${GITHUB_REPO:-}" ]]; then
  origin_url="$(git -C "$REPO_ROOT" remote get-url origin)"
  GITHUB_REPO="$(printf '%s' "$origin_url" \
    | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"
fi
if [[ ! "$GITHUB_REPO" =~ ^[^/]+/[^/]+$ ]]; then
  echo "Could not derive owner/repo from the origin remote. Set GITHUB_REPO=owner/repo." >&2
  exit 1
fi

API="https://api.github.com/repos/$GITHUB_REPO"

# Every call is non-interactive and fails loudly. `-sS` keeps curl quiet on
# success but still prints transport errors.
gh_api() { # $1 = method, $2 = path, $3 = optional JSON body
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method"
    -H "Authorization: Bearer $TOKEN"
    -H "Accept: application/vnd.github+json"
    -H "X-GitHub-Api-Version: 2022-11-28")
  if [[ -n "$body" ]]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi
  curl "${args[@]}" "$API$path"
}

# Desktop version, parsed without node (a Windows node cannot require() an MSYS
# path). Used only to place the downloaded artifacts.
VERSION="${VERSION:-$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  "$REPO_ROOT/apps/desktop/package.json" | head -1)}"

echo "== Dispatching $WORKFLOW =="
echo "   repo=$GITHUB_REPO  ref=$REF  DEMLI_DOMAIN=$DOMAIN  version=$VERSION"

# Record the cutoff BEFORE dispatching so we can tell our run apart from an
# older one. GitHub's created filter takes an ISO-8601 timestamp.
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

dispatch_status="$(curl -sS -o /tmp/mac-dispatch.out -w '%{http_code}' \
  -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -H "Content-Type: application/json" \
  -d "{\"ref\":\"$REF\",\"inputs\":{\"domain\":\"$DOMAIN\"}}" \
  "$API/actions/workflows/$WORKFLOW/dispatches")"

if [[ "$dispatch_status" != "204" ]]; then
  echo "Dispatch failed (HTTP $dispatch_status):" >&2
  cat /tmp/mac-dispatch.out >&2
  echo >&2
  if [[ "$dispatch_status" == "404" ]]; then
    echo "HTTP 404 usually means the workflow is not on the repository's DEFAULT branch." >&2
    echo "GitHub only exposes workflow_dispatch for workflows present there." >&2
  fi
  exit 1
fi
echo "   dispatched."

if [[ "${NO_WAIT:-0}" == "1" ]]; then
  echo "NO_WAIT=1 — not waiting. Watch: https://github.com/$GITHUB_REPO/actions/workflows/$WORKFLOW"
  exit 0
fi

# --- find the run we just created -------------------------------------------
echo "== Waiting for the run to appear =="
RUN_ID=""
for _ in $(seq 1 30); do
  sleep 4
  RUN_ID="$(gh_api GET "/actions/workflows/$WORKFLOW/runs?event=workflow_dispatch&created=>$since&per_page=1" \
    | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*\([0-9]\{6,\}\).*/\1/p' | head -1)"
  [[ -n "$RUN_ID" ]] && break
done
if [[ -z "$RUN_ID" ]]; then
  echo "The run did not appear within ~2 minutes. Check https://github.com/$GITHUB_REPO/actions" >&2
  exit 1
fi
RUN_URL="https://github.com/$GITHUB_REPO/actions/runs/$RUN_ID"
echo "   $RUN_URL"

# --- wait for it to finish ---------------------------------------------------
echo "== Building (macOS runners take ~15-30 min for two architectures) =="
status=""
conclusion=""
for _ in $(seq 1 120); do   # 120 * 30s = 60 min, above the workflow's 45 min timeout
  run_json="$(gh_api GET "/actions/runs/$RUN_ID")"
  status="$(printf '%s' "$run_json" | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([a-z_]*\)".*/\1/p' | head -1)"
  conclusion="$(printf '%s' "$run_json" | sed -n 's/.*"conclusion"[[:space:]]*:[[:space:]]*"\([a-z_]*\)".*/\1/p' | head -1)"
  printf '   status=%s\n' "$status"
  [[ "$status" == "completed" ]] && break
  sleep 30
done

if [[ "$status" != "completed" ]]; then
  echo "Timed out waiting for the run. Follow it at $RUN_URL" >&2
  exit 1
fi
if [[ "$conclusion" != "success" ]]; then
  echo "Run finished with conclusion='$conclusion'. Logs: $RUN_URL" >&2
  exit 1
fi
echo "   success."

# --- download + unpack the artifact -----------------------------------------
ARTIFACT_URL="$(gh_api GET "/actions/runs/$RUN_ID/artifacts" \
  | tr ',' '\n' | sed -n 's/.*"archive_download_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
if [[ -z "$ARTIFACT_URL" ]]; then
  echo "Run succeeded but exposed no artifact. Check $RUN_URL" >&2
  exit 1
fi

DEST="$REPO_ROOT/apps/desktop/release/$VERSION"
mkdir -p "$DEST"
ZIP="$DEST/macos-artifacts.zip"
echo "== Downloading artifacts -> $DEST =="
curl -sSL -H "Authorization: Bearer $TOKEN" -o "$ZIP" "$ARTIFACT_URL"

if command -v unzip >/dev/null 2>&1; then
  # The workflow uploads with `path: apps/desktop/release/*/*`, so the zip keeps
  # a release/<version>/ prefix; -j flattens it into $DEST where publish-desktop
  # looks.
  unzip -o -j "$ZIP" -d "$DEST" >/dev/null
  rm -f "$ZIP"
elif command -v python >/dev/null 2>&1; then
  python -c "import sys,zipfile,os,shutil; z=zipfile.ZipFile(sys.argv[1]); d=sys.argv[2]; [shutil.copyfileobj(z.open(n), open(os.path.join(d, os.path.basename(n)),'wb')) for n in z.namelist() if not n.endswith('/')]" "$ZIP" "$DEST"
  rm -f "$ZIP"
else
  echo "Downloaded $ZIP — no unzip/python available, extract it into $DEST by hand." >&2
  exit 1
fi

echo "== Artifacts =="
ls -lh "$DEST" | sed -n '1,20p'
echo
echo "Next:  bash scripts/publish-desktop.sh --mac"
