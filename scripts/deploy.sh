#!/usr/bin/env bash
#
# Demli production deploy — one command, idempotent, safe to re-run.
#
# Targets whatever Docker endpoint the CLI points at:
#   - locally on the VPS (default), or
#   - a remote VPS from your workstation via a docker context / SSH:
#       export DOCKER_HOST=ssh://user@vps-ip
#     (or `docker context use demli-vps` beforehand).
#
# Prerequisites (see docs/architecture/deploy.md):
#   - Docker + compose plugin on the target
#   - .env.prod present and filled in (copy from .env.prod.example)
#   - DNS A records at the VPS IP for EVERY host: the apex <DOMAIN> plus www,
#     app, api, ws, livekit and turn. All but `turn` have a Caddy vhost, and a
#     vhost whose name does not resolve makes Caddy retry its certificate
#     forever — so the Caddyfile host list and the DNS zone must match exactly
#     (enforced by `pnpm lint:caddy`).
#   - Firewall open: 80/443 tcp, 7881 tcp, 7882/3478 udp
#   - envsubst (gettext) available where this script runs
#
# What it does: render LiveKit config -> build images (tagged :${IMAGE_TAG},
# default `prod`) -> run DB migrations (one-shot) -> start/refresh the stack ->
# wait for API health -> re-create LiveKit if its rendered config changed (and
# prove the SFU can reach the join-check webhook) -> re-create Caddy if the
# Caddyfile changed -> PROVE the live proxy is serving the committed config (see
# the "Caddy" section below; a deploy that cannot prove it fails loudly instead
# of reporting success).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

ENV_FILE="${ENV_FILE:-.env.prod}"
COMPOSE_FILE="docker-compose.prod.yml"
COMPOSE=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")
CADDYFILE="${ROOT_DIR}/Caddyfile"

# Root of the bind-mounted host trees. Always /srv in production — it is a
# variable purely so scripts/test-deploy-migration.sh (`pnpm test:deploy`) can
# exercise this script against a scratch directory. Do NOT set it on the VPS.
SRV_ROOT="${SRV_ROOT:-/srv}"
CURRENT_DL_DIR="${SRV_ROOT}/demli-dl"

# Environment-scoped image tag (see the resolution below the env-file load).
# Captured BEFORE ${ENV_FILE} is sourced so an explicit `IMAGE_TAG=... bash
# scripts/deploy.sh` still wins over a value pinned in the env file — the same
# precedence docker compose uses for interpolation.
IMAGE_TAG_FROM_SHELL="${IMAGE_TAG:-}"

log() { printf '\n\033[1;36m[deploy]\033[0m %s\n' "$*"; }
fail() {
	printf '\n\033[1;31m[deploy] ERROR:\033[0m %s\n' "$*" >&2
	exit 1
}

# sha256 of a host file; empty when neither tool exists. Shared by the LiveKit
# and Caddy staleness checks.
file_sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" 2>/dev/null | awk '{print $1}'
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
	fi
}

# --- preflight --------------------------------------------------------------
command -v docker >/dev/null 2>&1 || fail "docker not found on PATH"
docker compose version >/dev/null 2>&1 || fail "docker compose plugin not available"
command -v envsubst >/dev/null 2>&1 || fail "envsubst not found (install the gettext package)"
[ -f "${ENV_FILE}" ] || fail "${ENV_FILE} missing. Copy .env.prod.example to ${ENV_FILE} and fill it in."

# Load env vars this script needs locally (DOMAIN / TURN_DOMAIN / secrets used
# by compose interpolation). Only KEY=VALUE lines; comments/blank lines ignored.
set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a

# Environment-scoped image tag. The app images are built ON this box, so a bare
# `:latest` is a shared mutable name: the moment a SECOND stack (staging) is
# ever built here it overwrites the very tag production restarts from, and the
# next `docker compose up` — or any container restart — silently puts staging
# code in front of real users. `:prod` makes the tag state which environment
# owns it; a second stack sets IMAGE_TAG=staging (plus its own compose `name:`)
# and the two can never collide.
IMAGE_TAG="${IMAGE_TAG_FROM_SHELL:-${IMAGE_TAG:-prod}}"
export IMAGE_TAG

: "${DOMAIN:?DOMAIN must be set in ${ENV_FILE}}"
: "${DATABASE_URL:?DATABASE_URL (Supabase connection string) must be set in ${ENV_FILE}}"
: "${LIVEKIT_API_KEY:?LIVEKIT_API_KEY must be set in ${ENV_FILE}}"
: "${LIVEKIT_API_SECRET:?LIVEKIT_API_SECRET must be set in ${ENV_FILE}}"
: "${REDIS_PASSWORD:?REDIS_PASSWORD must be set in ${ENV_FILE} (production Redis requires a password)}"

# Reject values that are still dev defaults or committed placeholders — presence
# alone is not enough: a copied-but-unfilled .env.prod would otherwise sign
# LiveKit media tokens with the publicly-known "devsecret" (security-review M5).
reject_placeholder() {
	local name="$1" value="$2"
	case "${value}" in
	"" | *REPLACE_WITH* | *YOUR_DB_PASSWORD* | *YOUR_PROJECT_REF* | devkey | devsecret | dev-only-change-me | changeme)
		fail "${name} in ${ENV_FILE} is empty or still a placeholder/dev default. Set a real value."
		;;
	esac
}
reject_placeholder DATABASE_URL "${DATABASE_URL}"
reject_placeholder LIVEKIT_API_KEY "${LIVEKIT_API_KEY}"
reject_placeholder LIVEKIT_API_SECRET "${LIVEKIT_API_SECRET}"
reject_placeholder REDIS_PASSWORD "${REDIS_PASSWORD}"

# APP_ENV must be production so the API/realtime containers activate their own
# fail-fast secret checks at boot (security-review M5).
if [ "${APP_ENV:-}" != "production" ]; then
	fail "APP_ENV must be set to 'production' in ${ENV_FILE} (activates the app-level secret checks)."
fi

# Every Caddy vhost is derived from DOMAIN, so a DOMAIN whose names do not
# resolve does not degrade — it takes the whole site down: no vhost answers for
# the names that DO resolve, and Caddy burns ACME attempts on the ones that do
# not. That is exactly what a deploy of the post-cutover Caddyfile against a
# stale .env.prod would do, so check before touching anything.
case "${DOMAIN}" in
karagozali.com | *.karagozali.com)
	fail "DOMAIN is still '${DOMAIN}', whose DNS records were deleted (2026-07-27).
  Every vhost in the Caddyfile derives from DOMAIN, so deploying like this
  serves nothing and the site goes down.
  Fix ${ENV_FILE} on this host first:  DOMAIN=getdemli.com"
	;;
esac

# Soft resolver check: if the box has a resolver, an unresolvable api.<DOMAIN>
# means the same outage, one deploy later. Skipped silently where neither
# getent nor host/dig exists (some minimal images).
if [ "${DEPLOY_SKIP_DNS_CHECK:-0}" != "1" ] && command -v getent >/dev/null 2>&1; then
	if ! getent hosts "api.${DOMAIN}" >/dev/null 2>&1; then
		fail "api.${DOMAIN} does not resolve. Add the DNS A records (see
  docs/architecture/deploy.md -> 'DNS records') before deploying, or Caddy will
  serve nothing for it. Set DEPLOY_SKIP_DNS_CHECK=1 to override deliberately."
	fi
fi

TURN_DOMAIN="${TURN_DOMAIN:-turn.${DOMAIN}}"
export TURN_DOMAIN

# --- render LiveKit config (TURN domain + webhook key ID; secret stays in env) -
#
# The template now carries the webhook block (server-side join check, M16), and
# a bad render there is not a cosmetic problem: a webhook `api_key` that names no
# configured key makes LiveKit REFUSE TO START ("api_key is required to use
# webhooks") — every call on the platform down. So the render is PROVEN here,
# before anything is built or touched:
#   - no placeholder survives on a non-comment line (a variable missing from the
#     envsubst list below would be left as literal `${…}` text);
#   - the webhook key is exactly LIVEKIT_API_KEY — the key the API verifies with;
#   - the SECRET is nowhere in the file (it is passed only via LIVEKIT_KEYS).
#
# The envsubst argument is a list of variable NAMES in single quotes. It must stay
# single-quoted: double quotes would expand the values into argv (and envsubst
# would then substitute nothing). Values reach envsubst through the environment.
#
# Written to a temp file and MOVED into place — a new inode, never an in-place
# truncation. That is what makes the "is the running LiveKit using this config?"
# check further down exact: the container's single-file bind mount keeps the
# inode it started with, so the file it sees is the file it loaded. (Writing in
# place with `>` would update the container's view under a process that never
# re-reads it, and the check would always say "up to date".)
LIVEKIT_TEMPLATE="deploy/livekit.yaml"
LIVEKIT_RUNTIME="deploy/livekit.runtime.yaml"
LIVEKIT_WEBHOOK_URL="http://api:4000/hooks/livekit"
livekit_tmp_files=()
cleanup_livekit_tmp() {
	local f
	for f in "${livekit_tmp_files[@]+"${livekit_tmp_files[@]}"}"; do rm -f "${f}"; done
}
trap cleanup_livekit_tmp EXIT

log "Rendering ${LIVEKIT_RUNTIME} (TURN_DOMAIN=${TURN_DOMAIN}, webhook -> ${LIVEKIT_WEBHOOK_URL})"
livekit_next="$(mktemp "${LIVEKIT_RUNTIME}.XXXXXX")"
livekit_tmp_files+=("${livekit_next}")
envsubst '${TURN_DOMAIN} ${LIVEKIT_API_KEY}' <"${LIVEKIT_TEMPLATE}" >"${livekit_next}"

unrendered="$(grep -nv '^[[:space:]]*#' "${livekit_next}" | grep -F '${' || true)"
[ -z "${unrendered}" ] || fail "the rendered LiveKit config still contains placeholders:
${unrendered}
  Add the variable to the envsubst list above (and to .env.prod). Nothing has been
  changed; the running SFU is untouched."

# The `api_key:` inside the top-level `webhook:` block, unquoted.
rendered_webhook_key="$(
	awk '
		/^webhook:[[:space:]]*$/ { inblock = 1; next }
		inblock && /^[^[:space:]#]/ { inblock = 0 }
		inblock && /^[[:space:]]+api_key:/ {
			sub(/^[[:space:]]+api_key:[[:space:]]*/, "")
			sub(/[[:space:]]+#.*$/, "")
			gsub(/^"|"$/, "")
			print
			exit
		}
	' "${livekit_next}"
)"
[ "${rendered_webhook_key}" = "${LIVEKIT_API_KEY}" ] || fail "the rendered LiveKit webhook api_key is not LIVEKIT_API_KEY.
  LiveKit would refuse to start (or sign with a key the API rejects). Check the
  webhook block in ${LIVEKIT_TEMPLATE}. The running SFU is untouched."
grep -qF "${LIVEKIT_WEBHOOK_URL}" "${livekit_next}" || fail "the rendered LiveKit config does not post to ${LIVEKIT_WEBHOOK_URL} —
  the server-side join check would be off. Check ${LIVEKIT_TEMPLATE}."
if grep -qF -- "${LIVEKIT_API_SECRET}" "${livekit_next}"; then
	fail "the LiveKit API SECRET appears in the rendered config. It must only ever
  reach the SFU through LIVEKIT_KEYS (docker-compose.prod.yml). Nothing written."
fi

# Same permissions an ordinary `>` redirect produced (mktemp is 0600, and the SFU
# reads the mount as whatever user the image runs as). Nothing secret is in it.
chmod 0644 "${livekit_next}"
mv -f "${livekit_next}" "${LIVEKIT_RUNTIME}"

# --- build images -----------------------------------------------------------
log "Building images (tag: ${IMAGE_TAG})"
"${COMPOSE[@]}" build

# --- pre-migration backup (the last frame before an irreversible change) ----
#
# Migrations are the one step of this deploy that cannot be rolled back by
# re-running it. `git reset && redeploy` restores CODE; it does not un-drop a
# column. So the dump is taken here — after the build (a build failure should not
# cost a backup) and immediately before the schema is touched, so the artifact is
# as close to the pre-migration state as it can be.
#
# A FAILED BACKUP STOPS THE DEPLOY. Applying an unreviewed migration to a live
# database with real users and no recovery point is the worst ordering available,
# and "the backup was broken that day" is only ever discovered later. Overriding
# this is possible but must be a deliberate, per-run act:
#   DEPLOY_SKIP_BACKUP=1 bash scripts/deploy.sh
if [ "${DEPLOY_SKIP_BACKUP:-0}" = "1" ]; then
	log "WARN: DEPLOY_SKIP_BACKUP=1 — migrations will run with NO recovery point.
  If this migration drops or rewrites anything, the data is gone."
else
	log "Taking the pre-migration database backup"
	BACKUP_DIR="${BACKUP_DIR:-${SRV_ROOT}/demli-backups}" \
		ENV_FILE="${ENV_FILE}" \
		bash "${SCRIPT_DIR}/backup-db.sh" --label predeploy ||
		fail "the pre-migration backup FAILED — refusing to run migrations.
  Nothing has been changed. Fix the backup first (docs/architecture/deploy.md ->
  'Database backups'), or accept the risk explicitly:
    DEPLOY_SKIP_BACKUP=1 bash scripts/deploy.sh"
fi

# Is anything backing this database up when nobody is deploying? The pre-deploy
# dump above only exists on days someone deploys, and a cron entry that exists
# proves nothing — only a recent FILE does. So look for a dump that no deploy
# wrote (no `-predeploy` label) from the last two days. Non-fatal: a fresh server
# legitimately has none, and this must never block a deploy.
# (`|| true` is load-bearing under `set -o pipefail`: on a server where the backup
# directory does not exist yet, find exits non-zero and the assignment would abort
# the whole deploy — from a check whose entire purpose is to be advisory.)
scheduled_backup="$(
	find "${BACKUP_DIR:-${SRV_ROOT}/demli-backups}" -maxdepth 1 -type f \
		-name 'demli-*.sql.gz' ! -name '*-predeploy.sql.gz' -mtime -2 2>/dev/null | head -1 || true
)"
if [ -z "${scheduled_backup}" ] && [ "${DEPLOY_SKIP_BACKUP:-0}" != "1" ]; then
	log "WARN: no SCHEDULED backup in the last 2 days (only deploy-time ones).
  Between deploys this database has no recovery point. Install the daily job:
    (crontab -l 2>/dev/null; echo '17 3 * * * cd /opt/demli && bash scripts/backup-db.sh >> /var/log/demli-backup.log 2>&1') | crontab -
  See docs/architecture/deploy.md -> 'Database backups'."
fi

# --- database migrations (one-shot; must succeed before serving) ------------
log "Applying database migrations against Supabase"
"${COMPOSE[@]}" run --rm migrate || fail "migrations failed — not starting/refreshing the stack"

log "Starting the stack"
"${COMPOSE[@]}" up -d --remove-orphans

# --- health check -----------------------------------------------------------
log "Waiting for the API to report healthy"
api_ok=""
for _ in $(seq 1 30); do
	if "${COMPOSE[@]}" exec -T api node -e \
		"fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
		>/dev/null 2>&1; then
		api_ok="yes"
		break
	fi
	sleep 2
done
[ -n "${api_ok}" ] || fail "API did not become healthy. Inspect: ${COMPOSE[*]} logs api"

# --- LiveKit: make the RUNNING SFU match the rendered config ------------------
#
# The same trap as Caddy below, one service over. LiveKit reads its config ONCE,
# at startup, and `up -d` recreates a container only when its service DEFINITION
# changes — a new livekit.runtime.yaml changes nothing compose can see. Until now
# a LiveKit config change therefore reached production only whenever the
# container happened to restart for some other reason; a deploy that added the
# webhook would have printed success while the join check stayed off.
#
# Oracle: the rendered file is moved into place as a NEW inode (see the render
# step), and a single-file bind mount keeps the inode the container started
# with — so /etc/livekit/livekit.yaml inside the container is exactly the config
# the running process loaded. Equal hashes => nothing to do (and no call is
# touched). Different => recreate.
#
# RECREATING LIVEKIT INTERRUPTS EVERY ACTIVE CALL. livekit-client reconnects on
# its own with the token it holds (measured on 1.9.12: an abrupt SFU restart with
# 1.8 s downtime -> both peers back after ~5 s); docker's SIGTERM grace and the
# apps' own voice state machine add to that and were not measured. Deploy a
# LiveKit config change when nobody is in a call. The recreate happens only when
# the config really changed, and only AFTER the API is healthy: the rejoin storm
# lands on a live webhook target, and the API's boot-time call sweep has already
# seen the old SFU's rooms, so the momentarily empty rooms fall under the
# sweeper's normal three-minute grace instead of its restart reconciliation.
#
# A new config that does not boot (LiveKit exits on an invalid webhook key) is
# rolled back to the config the old container was running, and the deploy fails.
#   DEPLOY_SKIP_LIVEKIT_RECREATE=1  defers the recreate (e.g. calls in progress);
#   the SFU then keeps its OLD config and the deploy says so.
livekit_container_config_sha256() {
	"${COMPOSE[@]}" exec -T livekit sha256sum /etc/livekit/livekit.yaml 2>/dev/null | awk '{print $1}'
}
livekit_answers() {
	"${COMPOSE[@]}" exec -T livekit wget -qO- http://127.0.0.1:7880/ >/dev/null 2>&1
}
wait_for_livekit() { # $1 = expected config sha256
	local _
	for _ in $(seq 1 30); do
		if [ "$(livekit_container_config_sha256 || true)" = "$1" ] && livekit_answers; then
			return 0
		fi
		sleep 2
	done
	return 1
}

log "Checking whether the running LiveKit has this config"
host_livekit_hash="$(file_sha256 "${LIVEKIT_RUNTIME}")"
live_livekit_hash="$(livekit_container_config_sha256 || true)"
livekit_config_stale=""
if [ -z "${host_livekit_hash}" ]; then
	fail "no sha256 tool on this host — cannot tell which config the running LiveKit uses."
elif [ "${live_livekit_hash}" = "${host_livekit_hash}" ]; then
	log "LiveKit already runs this config (${host_livekit_hash:0:12})."
elif [ "${DEPLOY_SKIP_LIVEKIT_RECREATE:-0}" = "1" ]; then
	livekit_config_stale="yes"
	log "WARN: DEPLOY_SKIP_LIVEKIT_RECREATE=1 — LiveKit keeps its OLD config
  (running ${live_livekit_hash:-unknown}, rendered ${host_livekit_hash}).
  Until it is recreated, config changes — including the webhook join check — are
  NOT in effect. Apply it when no call is running:
    ${COMPOSE[*]} up -d --no-deps --force-recreate livekit"
else
	# The config the old container is running is the known-good rollback target.
	livekit_rollback="$(mktemp "${LIVEKIT_RUNTIME}.XXXXXX")"
	livekit_tmp_files+=("${livekit_rollback}")
	if [ -n "${live_livekit_hash}" ]; then
		"${COMPOSE[@]}" exec -T livekit cat /etc/livekit/livekit.yaml >"${livekit_rollback}" 2>/dev/null || : >"${livekit_rollback}"
	else
		: >"${livekit_rollback}"
	fi

	log "LiveKit config changed (live ${live_livekit_hash:-none} -> rendered ${host_livekit_hash:0:12}).
  Recreating livekit — every active call is interrupted until its clients reconnect."
	# --no-deps: nothing else restarts (caddy depends_on livekit, not the reverse).
	"${COMPOSE[@]}" up -d --no-deps --force-recreate livekit

	if ! wait_for_livekit "${host_livekit_hash}"; then
		if [ -s "${livekit_rollback}" ]; then
			log "LiveKit did not come up on the new config — ROLLING BACK to the config it was running"
			chmod 0644 "${livekit_rollback}"
			mv -f "${livekit_rollback}" "${LIVEKIT_RUNTIME}"
			"${COMPOSE[@]}" up -d --no-deps --force-recreate livekit
			if wait_for_livekit "$(file_sha256 "${LIVEKIT_RUNTIME}")"; then
				fail "the new LiveKit config did not boot; the previous config is restored and
  LiveKit is serving again. The webhook join check is NOT active. Inspect:
    ${COMPOSE[*]} logs livekit"
			fi
			fail "LiveKit is DOWN: the new config did not boot and neither did the rollback.
  Voice is unavailable. Inspect immediately:
    ${COMPOSE[*]} logs livekit"
		fi
		fail "LiveKit did not come up on the new config and there was no previous config
  to roll back to. Voice is unavailable. Inspect: ${COMPOSE[*]} logs livekit"
	fi
	log "LiveKit recreated and serving config ${host_livekit_hash:0:12}."
fi

# --- proof: the SFU can actually reach the join-check webhook -----------------
# The URL in the config is only worth anything if the livekit container can
# resolve `api`, reach port 4000, and find the route there. An UNSIGNED POST from
# inside the livekit container must be answered 401 by the webhook handler: that
# proves name resolution, the network path and the route in one request, without
# being able to trigger anything (the signature check runs first). A 404, a DNS
# failure or a refused connection means every real delivery is being lost — the
# join check is silently off — so the deploy fails rather than warns.
if [ -z "${livekit_config_stale}" ]; then
	log "Verifying LiveKit can reach the join-check webhook (${LIVEKIT_WEBHOOK_URL})"
	webhook_probe="$(
		"${COMPOSE[@]}" exec -T livekit wget -q -O- \
			--header 'Content-Type: application/webhook+json' \
			--post-data '{}' "${LIVEKIT_WEBHOOK_URL}" 2>&1 || true
	)"
	case "${webhook_probe}" in
	*" 401"*) log "Webhook reachable from the SFU (unsigned probe -> 401, as it must)." ;;
	*)
		fail "LiveKit cannot deliver to ${LIVEKIT_WEBHOOK_URL} — the probe from the livekit
  container got: ${webhook_probe:-no answer}
  Expected an HTTP 401 from the webhook handler. Until this is fixed, a kicked user
  can rejoin a call with a still-valid token."
		;;
	esac
fi

# --- Caddy: make the RUNNING proxy match THIS Caddyfile ----------------------
#
# THE TRAP THIS CLOSES (production incident, 2026-07-27). New getdemli.com
# vhosts were deployed, this script reported success, /health answered — and
# Caddy went on serving the config it had parsed twenty minutes earlier. The new
# vhosts were never loaded; the logs did not even show a certificate attempt for
# the new names. Two independent causes, BOTH silent:
#
#   1. `docker compose up -d` recreates a container only when the SERVICE
#      DEFINITION changes — image, command, env, mount *declarations*, labels.
#      Changing the CONTENT of a bind-mounted file changes none of those, so
#      compose prints "Running" and does nothing at all.
#
#   2. ./Caddyfile is bind-mounted as a SINGLE FILE, and a single-file bind
#      mount binds the INODE, not the path. `git reset --hard` — exactly how
#      scripts/deploy-remote.sh updates the checkout — does not edit in place;
#      it writes a replacement, so the new content lands on a NEW inode. The
#      container's mount still resolves to the old one, and inside the container
#      /etc/caddy/Caddyfile keeps showing the OLD text indefinitely.
#
# Cause 2 is also why `caddy reload` did not fix it: reload re-reads that same
# stale inode and cheerfully reports success having re-applied the OLD config.
# Only recreating the container re-resolves the path to the current inode — so
# this step force-recreates rather than reloading. (If the mount were ever
# changed to a DIRECTORY, reload would start working — and the staleness oracle
# below would stop working. Do not change it without replacing both.)
#
# The upside of the inode behaviour: it is a perfect staleness oracle. Whatever
# /etc/caddy/Caddyfile reads as INSIDE the container is byte-for-byte what the
# running caddy process parsed at startup, so comparing it with the repo's file
# answers "is the live proxy running this config?" exactly. (file_sha256 is
# defined with the other helpers at the top — the LiveKit check uses it too.)

caddy_container_caddyfile_sha256() {
	"${COMPOSE[@]}" exec -T caddy sha256sum /etc/caddy/Caddyfile 2>/dev/null | awk '{print $1}'
}

# Site addresses declared in the Caddyfile, with {$DOMAIN} resolved: column-0
# lines that open a block. The global options block is a bare "{" and reduces to
# the empty string, so it drops out; multi-address sites ("a.x, b.y {") split on
# the comma. Deriving the list from the file means a new vhost is verified
# automatically, with no second list to keep in sync.
caddy_expected_hosts() {
	awk '
		/^[^[:space:]#]/ && /\{[[:space:]]*$/ {
			line = $0
			sub(/[[:space:]]*\{[[:space:]]*$/, "", line)
			n = split(line, addr, ",")
			for (i = 1; i <= n; i++) {
				gsub(/^[[:space:]]+|[[:space:]]+$/, "", addr[i])
				if (addr[i] != "") print addr[i]
			}
		}
	' "${CADDYFILE}" | sed "s/{[\$]DOMAIN}/${DOMAIN}/g" | sort -u
}

# Ask the running caddy process (not the file) what config it is serving.
caddy_running_config() {
	"${COMPOSE[@]}" exec -T caddy sh -c \
		'wget -qO- http://127.0.0.1:2019/config/ 2>/dev/null || curl -fsS http://127.0.0.1:2019/config/ 2>/dev/null'
}

log "Checking whether the running Caddy has this Caddyfile"
host_caddy_hash="$(file_sha256 "${CADDYFILE}")"
live_caddy_hash="$(caddy_container_caddyfile_sha256 || true)"
caddy_needs_recreate=""

if [ -z "${host_caddy_hash}" ]; then
	log "WARN: no sha256 tool on this host — recreating caddy unconditionally."
	caddy_needs_recreate="yes"
elif [ -z "${live_caddy_hash}" ]; then
	log "Caddy is not reporting a config file yet (first start / restarting) — recreating."
	caddy_needs_recreate="yes"
elif [ "${host_caddy_hash}" != "${live_caddy_hash}" ]; then
	log "Caddyfile changed (live ${live_caddy_hash:0:12} -> repo ${host_caddy_hash:0:12}) — recreating caddy."
	caddy_needs_recreate="yes"
else
	log "Caddy already runs this Caddyfile (${host_caddy_hash:0:12})."
fi

if [ -n "${caddy_needs_recreate}" ]; then
	# Validate FIRST, in a throwaway container built from the SAME service
	# definition (same image, env and mounts) — but with a FRESH mount, so it
	# reads the current file. An invalid Caddyfile must never reach the live
	# proxy: caddy would exit on start and take every vhost down at once.
	log "Validating the Caddyfile before touching the live proxy"
	"${COMPOSE[@]}" run --rm --no-deps --entrypoint caddy caddy \
		validate --config /etc/caddy/Caddyfile --adapter caddyfile ||
		fail "Caddyfile is invalid — refusing to recreate caddy. The live proxy is untouched."

	# --no-deps matters: without it, force-recreate would cascade to caddy's
	# depends_on (api, realtime, livekit) and restart the whole stack.
	log "Recreating the caddy container so it picks up the new Caddyfile"
	"${COMPOSE[@]}" up -d --no-deps --force-recreate caddy
fi

# --- proof: the live proxy really is serving THIS config ---------------------
# A deploy that "succeeded" while Caddy ran a twenty-minute-old config is the
# exact failure this whole section exists for, so the deploy is NOT allowed to
# report success on the strength of having run the right commands. It has to
# prove the outcome, every time — including on deploys that changed nothing.
log "Verifying the live Caddy configuration"

live_caddy_hash="$(caddy_container_caddyfile_sha256 || true)"
if [ -n "${host_caddy_hash}" ] && [ "${live_caddy_hash}" != "${host_caddy_hash}" ]; then
	fail "caddy is STILL mounting a different Caddyfile (container '${live_caddy_hash:-none}', repo '${host_caddy_hash}').
  Recreate it by hand and investigate:
    ${COMPOSE[*]} up -d --no-deps --force-recreate caddy"
fi

running_config=""
for _ in $(seq 1 15); do
	running_config="$(caddy_running_config || true)"
	[ -n "${running_config}" ] && break
	sleep 1
done
[ -n "${running_config}" ] || fail "Caddy's admin API (127.0.0.1:2019 inside the container) returned
  nothing, so which config is live cannot be proven. Inspect: ${COMPOSE[*]} logs caddy"

missing_hosts=""
present_hosts=""
while IFS= read -r host; do
	[ -n "${host}" ] || continue
	case "${running_config}" in
	*"\"${host}\""*) present_hosts="${present_hosts} ${host}" ;;
	*) missing_hosts="${missing_hosts} ${host}" ;;
	esac
done <<EOF
$(caddy_expected_hosts)
EOF

[ -z "${missing_hosts}" ] || fail "the RUNNING Caddy config is missing vhosts:${missing_hosts}
  The committed Caddyfile declares them, so the proxy is serving a stale or
  partial config — this is the 2026-07-27 failure mode. Force it:
    ${COMPOSE[*]} up -d --no-deps --force-recreate caddy"
log "Live Caddy vhosts:${present_hosts}"

# Final, end-to-end proof: a real request over the public edge. The container
# health check above talks to the API directly, so it says nothing about TLS,
# DNS or the proxy — this is the only step that exercises the whole path.
if [ "${DEPLOY_SKIP_EDGE_CHECK:-0}" = "1" ]; then
	log "WARN: DEPLOY_SKIP_EDGE_CHECK=1 — public-edge check skipped. Verify by hand:
  curl -fsS https://api.${DOMAIN}/health"
elif command -v curl >/dev/null 2>&1; then
	log "Verifying the public edge (DNS + TLS + Caddy routing)"
	edge_ok=""
	for _ in $(seq 1 30); do
		if curl -fsS --max-time 5 "https://api.${DOMAIN}/health" >/dev/null 2>&1; then
			edge_ok="yes"
			break
		fi
		sleep 2
	done
	[ -n "${edge_ok}" ] || fail "https://api.${DOMAIN}/health did not answer through Caddy within 60s.
  The container health check passed, so the API itself is fine — this is DNS,
  TLS or the proxy. Check:
    ${COMPOSE[*]} logs caddy
    dig api.${DOMAIN}
  Set DEPLOY_SKIP_EDGE_CHECK=1 to deploy without this proof (not recommended)."
	log "Public edge OK: https://api.${DOMAIN}/health"
else
	log "WARN: curl not found — public-edge check skipped. Verify by hand:
  curl -fsS https://api.${DOMAIN}/health"
fi

# --- stable download alias ----------------------------------------------------
# https://<DOMAIN>/download/{windows,macos} redirect to VERSION-INDEPENDENT
# filenames so a release never breaks the landing links. Each filename is a
# RELATIVE symlink living next to the versioned installer in the download tree;
# scripts/publish-desktop.sh re-points it after every upload, and this pass
# covers the installers already on disk so the link works from the first deploy
# onward (and self-heals if the symlink is ever lost).
#
# electron-updater is untouched: it resolves the VERSIONED filename out of
# latest.yml. Non-fatal by design — a missing download dir must never fail a
# deploy that is otherwise healthy.
DL_DESKTOP_DIR="${DL_DESKTOP_DIR:-${CURRENT_DL_DIR}/desktop}"
if [ -d "${DL_DESKTOP_DIR}" ]; then
	newest_setup="$(ls -1 "${DL_DESKTOP_DIR}"/Demli-Setup-*.exe 2>/dev/null | sort -V | tail -1 || true)"
	if [ -n "${newest_setup}" ]; then
		if ln -sfn "$(basename "${newest_setup}")" "${DL_DESKTOP_DIR}/Demli-Setup.exe" 2>/dev/null; then
			log "Stable installer alias Demli-Setup.exe -> $(basename "${newest_setup}")"
		else
			log "WARN: could not refresh ${DL_DESKTOP_DIR}/Demli-Setup.exe (check permissions)"
		fi
	else
		log "No Demli-Setup-*.exe in ${DL_DESKTOP_DIR} yet — /download/windows will 404 until the next desktop publish."
	fi

	# Same treatment for macOS. Apple Silicon first (see publish-desktop.sh for
	# why); absent entirely until the first macOS release is published, which is
	# why the landing page must not show a macOS button yet.
	newest_dmg=""
	for candidate in "${DL_DESKTOP_DIR}"/Demli-*-arm64.dmg "${DL_DESKTOP_DIR}"/Demli-*-x64.dmg; do
		[ -f "${candidate}" ] || continue
		newest_dmg="${candidate}"
		break
	done
	if [ -n "${newest_dmg}" ]; then
		if ln -sfn "$(basename "${newest_dmg}")" "${DL_DESKTOP_DIR}/Demli-macos.dmg" 2>/dev/null; then
			log "Stable macOS alias Demli-macos.dmg -> $(basename "${newest_dmg}")"
		else
			log "WARN: could not refresh ${DL_DESKTOP_DIR}/Demli-macos.dmg (check permissions)"
		fi
	else
		log "No Demli-*.dmg in ${DL_DESKTOP_DIR} yet — /download/macos will 404 until the first macOS publish."
	fi
fi

# --- the mobile APK the server ADVERTISES must actually exist -----------------
# `GET /mobile/version` hands every install an `apkUrl`, and the in-app updater
# downloads exactly that. So a missing file there is not a dead link, it is an
# update loop: the app is told a newer runtime exists, fails to fetch it, and
# asks again on the next launch, forever.
#
# That is not hypothetical: the advertised name and the name on disk have drifted
# before, with every check green, because nothing compared the two. This does.
#
# Deliberately a WARNING, not a failure: an API/realtime deploy is unrelated to
# mobile artifacts and must not be blocked by one. The point is that it can no
# longer be missed.
DL_MOBILE_DIR="${DL_MOBILE_DIR:-${CURRENT_DL_DIR}/mobile}"
advertised_apk="$(
	grep -Eo 'MOBILE_APK_URL:[[:space:]]*"[^"]+"' docker-compose.prod.yml 2>/dev/null |
		head -1 | sed 's/.*\///; s/"//'
)"
if [ -n "${advertised_apk}" ]; then
	if [ -s "${DL_MOBILE_DIR}/${advertised_apk}" ]; then
		log "Mobile APK OK: ${advertised_apk} ($(du -h "${DL_MOBILE_DIR}/${advertised_apk}" | cut -f1))"
	else
		log "WARN: /mobile/version advertises '${advertised_apk}' but ${DL_MOBILE_DIR}/${advertised_apk} is missing."
		# `|| true` is load-bearing: with `set -o pipefail`, an `ls` that matches
		# nothing fails the whole pipeline, the assignment inherits that status,
		# and `set -e` aborts the deploy — at the very end, on an otherwise
		# healthy stack, purely because no APK has been published yet. Which is
		# precisely the state of a fresh server. (Caught by
		# scripts/test-deploy-migration.sh scenario 1.)
		other="$(ls -1 "${DL_MOBILE_DIR}"/*.apk 2>/dev/null | head -3 | xargs -r -n1 basename | tr '\n' ' ' || true)"
		[ -n "${other}" ] && log "WARN:   present instead: ${other}— publish under the advertised name (scripts/publish-mobile-apk.sh)."
		log "WARN:   every install will be told to update and then fail to download it."
	fi
fi

# --- the release feed must actually be SERVED, not merely present on disk -----
#
# THE GAP THIS CLOSES (security-review, HIGH). Every check above this point
# asked either "is the file on disk?" or "does /health answer?". Neither notices
# the failure mode that actually happened: the download tree ends up mounted from
# the WRONG host directory (a bind source Docker silently created empty),
# so the files exist, /health is green, the deploy reports success — and every
# download 404s. For the mobile APK that is not a broken link, it is the endless
# update loop of CLAUDE.md §32.
#
# The only check that can see it is a real HTTP request for a real artifact,
# which is what this does. A file that is on disk but does not answer 200 through
# the public edge is unambiguously a routing/mount fault, so it FAILS the deploy
# rather than warning: this whole block exists because a warning is exactly what
# gets scrolled past. Files that are simply absent were already reported above
# and are skipped here — an API deploy is not a release.
if [ "${DEPLOY_SKIP_EDGE_CHECK:-0}" = "1" ]; then
	log "WARN: DEPLOY_SKIP_EDGE_CHECK=1 — release-feed serving check skipped."
elif ! command -v curl >/dev/null 2>&1; then
	log "WARN: curl not found — release-feed serving check skipped."
else
	log "Verifying the release feed is actually served (not just present on disk)"
	feed_broken=""

	verify_served() { # $1 = file on disk, $2 = public URL
		local path="$1" url="$2" code
		[ -s "${path}" ] || [ -L "${path}" ] || return 0 # absent: already reported above
		code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -L "${url}" 2>/dev/null || echo 000)"
		if [ "${code}" = "200" ]; then
			log "  served ${url}"
		else
			log "  NOT SERVED ${url} -> HTTP ${code} (file exists: ${path})"
			feed_broken="yes"
		fi
	}

	# The desktop manifest name follows electron-builder's `channel:`; read it
	# rather than hardcoding, for the same reason publish-desktop.sh does.
	desktop_channel="$(
		sed -n 's/^[[:space:]]*channel:[[:space:]]*\([A-Za-z0-9._-][A-Za-z0-9._-]*\).*/\1/p' \
			apps/desktop/electron-builder.yml 2>/dev/null | head -1
	)"
	if [ -n "${desktop_channel}" ]; then
		verify_served "${DL_DESKTOP_DIR}/${desktop_channel}.yml" \
			"https://api.${DOMAIN}/dl/desktop/${desktop_channel}.yml"
	fi
	verify_served "${DL_DESKTOP_DIR}/Demli-Setup.exe" \
		"https://api.${DOMAIN}/dl/desktop/Demli-Setup.exe"
	if [ -n "${advertised_apk}" ]; then
		verify_served "${DL_MOBILE_DIR}/${advertised_apk}" \
			"https://api.${DOMAIN}/dl/mobile/${advertised_apk}"
	fi
	[ -z "${feed_broken}" ] || fail "artifacts exist on disk but are NOT served over the public edge.
  The stack is healthy, so this is the download tree: Caddy is serving a
  different directory than the one the files are in (check the /srv/demli-dl
  bind mount).
  Left unfixed this is the endless mobile update loop — every install is told to
  update and cannot fetch the APK."
fi

# --- disk hygiene -------------------------------------------------------------
# Images are built ON the VPS, so every deploy strands the previous build as a
# dangling image (~1 GB each) and grows the buildkit cache without bound. On a
# small disk this eventually fills the filesystem and takes the whole stack
# down. Prune only after the new stack is confirmed healthy.
log "Pruning dangling images and old build cache"
docker image prune -f >/dev/null || true
docker builder prune -f --keep-storage=3GB >/dev/null 2>&1 || true

# Retire the pre-2026-07-27 `:latest` tags. `docker image prune` never touches a
# TAGGED image, so without this they sit on the disk forever (~1 GB each) and,
# worse, stay available as a plausible-looking thing to `docker run` months from
# now — carrying the dead karagozali.com endpoints. Nothing references them any
# more (the stack is on :${IMAGE_TAG}); rollback here has always meant
# "git reset + redeploy", never "restart an old image". Idempotent and
# non-fatal, and only reached once the new stack is verified healthy.
#
# NOTE: every entry below must be a name the CURRENT stack does not use. The
# live images are `demli/*:${IMAGE_TAG}` — never list those.
for legacy_image in \
	demli/api:latest demli/realtime:latest; do
	case "${legacy_image}" in
	demli/*:latest) [ "${IMAGE_TAG}" != "latest" ] || continue ;;
	esac
	if docker image inspect "${legacy_image}" >/dev/null 2>&1; then
		if docker image rm "${legacy_image}" >/dev/null 2>&1; then
			log "Retired legacy image tag ${legacy_image}"
		fi
	fi
done

log "Deploy complete."
"${COMPOSE[@]}" ps
cat <<EOF

Next:
  - Verify TLS:   curl -fsS https://api.${DOMAIN}/health
  - Point clients at:  API https://api.${DOMAIN}   WS wss://ws.${DOMAIN}   LiveKit wss://livekit.${DOMAIN}
  - Public web:
      curl -fsS -I https://${DOMAIN}                                   # landing
      curl -fsS -I https://app.${DOMAIN}                                # web app
      curl -fsS -o /dev/null -w '%{http_code}\n' https://api.${DOMAIN}/dl/desktop/latest.yml
    A 'could not resolve host' / TLS error means that host's A record is missing.
    TURN has no vhost — it is UDP/3478 straight off the host, on ${TURN_DOMAIN}.
  - Tail logs:    ${COMPOSE[*]} logs -f
EOF
