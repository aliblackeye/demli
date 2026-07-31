#!/usr/bin/env bash
#
# Demli database backup — one compressed logical dump, verified before it counts.
#
#   bash scripts/backup-db.sh                    # ad-hoc / cron
#   bash scripts/backup-db.sh --label predeploy  # what scripts/deploy.sh runs
#
# WHY THIS EXISTS
# ---------------
# The production database is Supabase (managed Postgres) and there was no dump of
# it anywhere — not in this repo, not on the VPS. Meanwhile scripts/deploy.sh
# applies Drizzle migrations to that live database on every deploy, unattended.
# A generated `DROP COLUMN` reaches real user data one deploy later and there is
# nothing to go back to. The free Supabase tier includes no automatic backups and
# no PITR, so "the provider has it" is not true here.
#
# WHAT IT PRODUCES
#   ${BACKUP_DIR}/demli-<UTC timestamp>[-<label>].sql.gz   (mode 600)
#
# A PLAIN SQL dump, gzipped — restorable with nothing but `psql`, greppable, and
# diffable. Restoring needs no pg_restore whose version must match anything.
#
# THE DUMP CONTAINS NO `DROP`. There is deliberately no --clean/--if-exists: the
# artifact must never be able to destroy a live database if someone applies it to
# the wrong target in a panic. Restore into a FRESH database (that is what
# scripts/restore-db-verify.sh does, and what the runbook says).
#
# SCHEMAS: `public` AND `drizzle`.
#   `drizzle.__drizzle_migrations` is the migration bookkeeping table (created by
#   drizzle-orm's migrator, which defaults to schema "drizzle"). A public-only
#   dump looks perfect and restores cleanly — and then the next deploy's migrate
#   step sees an empty ledger and replays EVERY migration from 0000 against a
#   populated database. The recovery would be the second outage. Supabase's own
#   `auth`/`storage`/`extensions` schemas are excluded: they belong to the
#   platform, are owned by roles that do not exist anywhere else, and are not
#   ours to restore.
#
# RETENTION (BACKUP_RETENTION_DAYS / BACKUP_MONTHLY_RETENTION_DAYS)
#   14 days of dailies, plus the 1st-of-month dump kept for 180 days.
#   Two failure shapes, two horizons: an accidental delete or a bad migration is
#   noticed within days (14 covers a holiday), while slow corruption — a bug that
#   has been mangling one column since spring — is noticed months later, and by
#   then every daily is already poisoned. The monthly keeps a pre-poisoning copy
#   without unbounded growth: this database is small enough that ~20 gzipped
#   dumps cost megabytes.
#
# WHERE THE FILES LIVE (BACKUP_DIR, default /srv/demli-backups)
#   * OUTSIDE the git checkout: scripts/deploy-remote.sh `git reset --hard`s
#     /opt/demli on every deploy, and backups must not live where a deploy tool
#     writes.
#   * NOT under /srv/demli-dl: that tree is bind-mounted into Caddy and served at
#     https://api.<DOMAIN>/dl/. A dump there would be a public download of every
#     user's data. `pnpm lint:deploy` fails if the two ever overlap.
#   * On the VPS, i.e. NOT on the same machine as the database. That is the one
#     genuinely good property of this arrangement and it is an accident of the
#     topology, not a design: the DB is at Supabase, the dumps are on the VPS, so
#     no single provider failure takes both. The honest limit is the other
#     direction — losing the VPS disk loses the backup HISTORY (the live database
#     is untouched). Set BACKUP_MIRROR_DIR to also drop each dump somewhere else
#     (mounted volume, second disk); see docs/architecture/deploy.md.
#
# The dump is only reported as a backup after it is checked: gzip integrity, the
# pg_dump completion trailer, and a shape assertion that the expected tables are
# actually in it. An untested backup is not a backup — and the proof that it can
# be RESTORED is a separate script: scripts/restore-db-verify.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

PGB_TAG="db-backup"
export PGB_TAG
# shellcheck source=scripts/lib/pg-backup.sh
. "${SCRIPT_DIR}/lib/pg-backup.sh"

LABEL=""
BACKUP_DIR="${BACKUP_DIR:-/srv/demli-backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
MONTHLY_RETENTION_DAYS="${BACKUP_MONTHLY_RETENTION_DAYS:-180}"
ENV_FILE="${ENV_FILE:-.env.prod}"

usage() {
	cat <<'EOF'
Usage: bash scripts/backup-db.sh [--label NAME] [--dir PATH] [--keep-days N]

  --label NAME     suffix for the filename (e.g. predeploy)
  --dir PATH       where to write (default: $BACKUP_DIR or /srv/demli-backups)
  --keep-days N    daily retention in days (default: 14)

Environment:
  DATABASE_URL              read from the environment or $ENV_FILE (.env.prod)
  BACKUP_PG_MODE            auto|docker|local  (default auto: docker if present)
  BACKUP_PG_IMAGE           default postgres:17-alpine
  BACKUP_PG_DOCKER_ARGS     extra `docker run` args (networking, test harness)
  BACKUP_MIRROR_DIR         optional second destination for each dump
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
	--label)
		LABEL="${2:-}"
		shift 2
		;;
	--dir)
		BACKUP_DIR="${2:-}"
		shift 2
		;;
	--keep-days)
		RETENTION_DAYS="${2:-}"
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	*) pgb_fail "unknown argument: $1 (try --help)" ;;
	esac
done

# The label becomes part of the dump's FILE NAME, so it must not be able to carry
# a path. A leading-character check is not enough — `[A-Za-z0-9]*` accepts
# `a;x/../..` because the glob only pins the first byte. Match on the presence of
# any disallowed byte instead, which is the only form that constrains the whole
# string in POSIX sh.
case "${LABEL}" in
"") ;;
*[!A-Za-z0-9_-]*) pgb_fail "--label may only contain letters, digits, '-' and '_' (got '${LABEL}')" ;;
esac

# --- target ------------------------------------------------------------------
pgb_load_env_file "${ENV_FILE}"
pgb_export_libpq_env

command -v gzip >/dev/null 2>&1 || pgb_fail "gzip not found."

mkdir -p "${BACKUP_DIR}" || pgb_fail "cannot create ${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}" 2>/dev/null || true
[ -w "${BACKUP_DIR}" ] || pgb_fail "${BACKUP_DIR} is not writable by $(id -un 2>/dev/null || echo "this user")"

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
NAME="demli-${STAMP}${LABEL:+-${LABEL}}.sql.gz"
OUT="${BACKUP_DIR}/${NAME}"
TMP="${OUT}.part"

cleanup_tmp() { rm -f "${TMP}"; }
trap cleanup_tmp EXIT

pgb_log "Dumping $(pgb_masked_target) -> ${OUT}"
pgb_step "runner: $(pgb_pg_runner)$([ "$(pgb_pg_runner)" = "docker" ] && printf ' (%s)' "$(pgb_pg_image)")"

# --no-owner/--no-privileges: Supabase's roles do not exist in a recovery target,
# and a dump that only restores as `postgres@supabase` is a dump that does not
# restore. --format=plain keeps psql as the only tool a restore needs.
if ! pgb_run_pg pg_dump \
	--no-owner \
	--no-privileges \
	--schema=public \
	--schema=drizzle \
	--format=plain \
	--encoding=UTF8 |
	gzip -9 >"${TMP}"; then
	pgb_fail "pg_dump failed — NO backup was written.
  If it complained about the server version, the pinned image is older than the
  managed Postgres: re-run with BACKUP_PG_IMAGE=postgres:<major>-alpine and
  update the default in this script."
fi

# --- the dump does not count until it is checked -----------------------------
[ -s "${TMP}" ] || pgb_fail "pg_dump produced an empty file."

gzip -t "${TMP}" 2>/dev/null || pgb_fail "the gzip stream is corrupt — refusing to keep it."

pgb_dump_is_complete "${TMP}" ||
	pgb_fail "the dump has no 'PostgreSQL database dump complete' trailer, so it is
  TRUNCATED (dropped connection, full disk, OOM kill). It is valid gzip full of
  plausible SQL, which is exactly why this is checked and not assumed."

# Shape check. A dump of the wrong database, or of an empty one, passes every
# check above — it is well-formed, complete, and useless. These tables have
# existed since migration 0000; if they are not in the artifact, whatever was
# dumped is not this product's database.
#
# One decompression pass into a variable, deliberately: `gzip -cd … | grep -q`
# would make grep exit early, kill gzip with SIGPIPE, and — under `set -o
# pipefail` — report the pipeline as FAILED precisely when the table WAS found.
created="$(gzip -cd "${TMP}" | sed -n 's/^CREATE TABLE \([^ ]*\) .*/\1/p' | tr -d '"')"

missing=""
for table in users messages friend_groups channels; do
	case "
${created}
" in
	*"
public.${table}
"*) ;;
	*) missing="${missing} ${table}" ;;
	esac
done
[ -z "${missing}" ] || pgb_fail "the dump is missing core tables:${missing}
  Either DATABASE_URL points at the wrong database, or the schema is not what
  this deployment runs. Nothing was kept."

case "${created}" in
*drizzle.*) ;;
*) pgb_fail "the dump has no drizzle schema — the migration ledger
  (drizzle.__drizzle_migrations) is missing, so a restore from it would make the
  next deploy replay every migration from 0000 against restored data." ;;
esac

mv -f "${TMP}" "${OUT}"
chmod 600 "${OUT}" 2>/dev/null || true
trap - EXIT

# --- optional second destination --------------------------------------------
if [ -n "${BACKUP_MIRROR_DIR:-}" ]; then
	if mkdir -p "${BACKUP_MIRROR_DIR}" 2>/dev/null && cp -f "${OUT}" "${BACKUP_MIRROR_DIR}/${NAME}" 2>/dev/null; then
		chmod 600 "${BACKUP_MIRROR_DIR}/${NAME}" 2>/dev/null || true
		pgb_step "mirrored to ${BACKUP_MIRROR_DIR}/${NAME}"
	else
		# A mirror is a second copy, not the copy. Losing it must not lose the
		# backup that already succeeded — but it must be visible.
		pgb_warn "could not mirror to ${BACKUP_MIRROR_DIR} — the primary copy at ${OUT} is fine."
	fi
fi

# --- retention ---------------------------------------------------------------
# Age is taken from the file's mtime, not from the name: a file's name can be
# anything, its mtime is when it was written here.
pruned=0
case "${RETENTION_DAYS}" in
'' | *[!0-9]*) pgb_fail "--keep-days / BACKUP_RETENTION_DAYS must be a number (got '${RETENTION_DAYS}')" ;;
esac
case "${MONTHLY_RETENTION_DAYS}" in
'' | *[!0-9]*) pgb_fail "BACKUP_MONTHLY_RETENTION_DAYS must be a number (got '${MONTHLY_RETENTION_DAYS}')" ;;
esac
if [ "${RETENTION_DAYS}" -gt 0 ]; then
	while IFS= read -r old; do
		[ -n "${old}" ] || continue
		rm -f "${old}" && pruned=$((pruned + 1))
	done < <(find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'demli-*.sql.gz' \
		! -name 'demli-????-??-01T*' -mtime "+${RETENTION_DAYS}" 2>/dev/null)
fi
if [ "${MONTHLY_RETENTION_DAYS}" -gt 0 ]; then
	while IFS= read -r old; do
		[ -n "${old}" ] || continue
		rm -f "${old}" && pruned=$((pruned + 1))
	done < <(find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'demli-????-??-01T*.sql.gz' \
		-mtime "+${MONTHLY_RETENTION_DAYS}" 2>/dev/null)
fi

# --- report ------------------------------------------------------------------
size="$(du -h "${OUT}" 2>/dev/null | cut -f1)"
stats="$(pgb_dump_table_stats "${OUT}")"
tables="$(printf '%s\n' "${stats}" | grep -c . || true)"
rows="$(printf '%s\n' "${stats}" | awk -F'\t' '{ t += $2 } END { print t + 0 }')"
kept="$(find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'demli-*.sql.gz' | wc -l | tr -d ' ')"

pgb_log "Backup complete"
pgb_step "file       ${OUT} (${size:-?})"
pgb_step "contents   ${tables} tables, ${rows} data rows"
pgb_step "retention  ${RETENTION_DAYS}d daily + ${MONTHLY_RETENTION_DAYS}d monthly; ${kept} kept, ${pruned} pruned"
pgb_step "verify     bash scripts/restore-db-verify.sh ${OUT}"
pgb_storage_gap_notice
