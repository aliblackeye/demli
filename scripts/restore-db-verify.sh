#!/usr/bin/env bash
#
# Prove a Demli backup can actually be restored — the only thing that turns a
# .sql.gz into a backup.
#
#   bash scripts/restore-db-verify.sh                      # newest dump in BACKUP_DIR
#   bash scripts/restore-db-verify.sh /path/to/dump.sql.gz
#
# WHY THIS IS A SEPARATE SCRIPT AND NOT A FLAG
# --------------------------------------------
# scripts/backup-db.sh checks that the ARTIFACT is well-formed: valid gzip, the
# pg_dump completion trailer, the expected tables mentioned in the SQL. Every one
# of those can pass on a dump that no database will ever accept — a dependency
# ordering pg_dump got wrong for a schema it does not own, an encoding the target
# rejects, a generated column that cannot be inserted into. The only check that
# cannot lie is running the restore and looking at what came back, so that is
# what this does:
#
#   1. start a THROWAWAY Postgres container (--network none: it can reach
#      nothing, so nothing it does can touch production),
#   2. create an empty database and restore the dump into it in ONE transaction,
#   3. compare the restored database against the dump ROW BY ROW — the dump says
#      N rows for a table, the restored table must have exactly N,
#   4. assert the things a "successful" partial restore silently loses: the
#      migration ledger, foreign keys, indexes,
#   5. destroy the scratch container.
#
# PRODUCTION IS NEVER A TARGET. There is deliberately no "restore into this URL"
# option: this script can only ever write to a container it started itself. The
# real recovery procedure is in docs/architecture/deploy.md, where a human runs it
# deliberately against a NEW database.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

PGB_TAG="restore-verify"
export PGB_TAG
# shellcheck source=scripts/lib/pg-backup.sh
. "${SCRIPT_DIR}/lib/pg-backup.sh"

BACKUP_DIR="${BACKUP_DIR:-/srv/demli-backups}"
IMAGE="${RESTORE_PG_IMAGE:-${BACKUP_PG_IMAGE:-postgres:17-alpine}}"
SCRATCH_DB="demli_restore_check"

DUMP="${1:-}"
if [ -z "${DUMP}" ]; then
	DUMP="$(find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'demli-*.sql.gz' 2>/dev/null | sort | tail -1)"
	[ -n "${DUMP}" ] || pgb_fail "no dump given and none found in ${BACKUP_DIR}.
  Take one first:  bash scripts/backup-db.sh"
fi
[ -f "${DUMP}" ] || pgb_fail "${DUMP} does not exist."

command -v docker >/dev/null 2>&1 ||
	pgb_fail "docker is required: the restore target is a throwaway container so that
  production can never be one."
command -v gzip >/dev/null 2>&1 || pgb_fail "gzip not found."

WORK="$(mktemp -d)"
CONTAINER="demli-restore-verify-$$"
cleanup() {
	docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
	rm -rf "${WORK}"
}
trap cleanup EXIT

pass=0
fail=0
ok() {
	pgb_ok "$1"
	pass=$((pass + 1))
}
no() {
	pgb_bad "$1"
	fail=$((fail + 1))
}

pgb_log "Verifying ${DUMP}"
pgb_step "size       $(du -h "${DUMP}" 2>/dev/null | cut -f1)"
pgb_step "scratch    ${IMAGE} in container ${CONTAINER} (network: none)"

# --- 1. the artifact ---------------------------------------------------------
if gzip -t "${DUMP}" 2>/dev/null; then ok "gzip stream is intact"; else no "gzip stream is CORRUPT"; fi
if pgb_dump_is_complete "${DUMP}"; then
	ok "pg_dump completion trailer present (not truncated)"
else
	no "no completion trailer — the dump is truncated"
fi
[ "${fail}" -eq 0 ] || pgb_fail "the artifact is broken; there is nothing to restore."

pgb_dump_table_stats "${DUMP}" | sort >"${WORK}/dump-counts.tsv"
dump_tables="$(grep -c . <"${WORK}/dump-counts.tsv" || true)"
dump_rows="$(awk -F'\t' '{ t += $2 } END { print t + 0 }' <"${WORK}/dump-counts.tsv")"
pgb_step "dump says  ${dump_tables} tables, ${dump_rows} data rows"

# --- 2. scratch server -------------------------------------------------------
docker run -d --rm \
	--name "${CONTAINER}" \
	--network none \
	-e POSTGRES_PASSWORD=restore-verify \
	-e POSTGRES_DB=postgres \
	"${IMAGE}" >/dev/null || pgb_fail "could not start the scratch ${IMAGE} container."

ready=""
for _ in $(seq 1 60); do
	if docker exec "${CONTAINER}" pg_isready -U postgres -q >/dev/null 2>&1; then
		ready="yes"
		break
	fi
	sleep 1
done
if [ -n "${ready}" ]; then
	ok "scratch Postgres is up ($(docker exec "${CONTAINER}" psql -U postgres -Atqc 'show server_version' 2>/dev/null))"
else
	docker logs "${CONTAINER}" 2>&1 | tail -20 >&2
	pgb_fail "the scratch Postgres never became ready."
fi

psql_scratch() { docker exec -i "${CONTAINER}" psql -U postgres -v ON_ERROR_STOP=1 "$@"; }

psql_scratch -d postgres -Atqc "CREATE DATABASE ${SCRATCH_DB}" >/dev/null ||
	pgb_fail "could not create the scratch database."

# DROP THE PRE-CREATED `public` SCHEMA FIRST. This is not a detail of the test
# harness — it is a required step of the real recovery procedure, and it was
# found by this script failing on the very first dump it was pointed at:
#
#   psql:<stdin>:33: ERROR:  schema "public" already exists
#
# A schema-scoped dump (`pg_dump --schema=public`) emits `CREATE SCHEMA public;`,
# and every freshly created Postgres database already has one. With
# ON_ERROR_STOP + --single-transaction the whole restore then rolls back, so the
# artifact that passed every integrity check restores to NOTHING. The dump is
# deliberately left exactly as pg_dump wrote it; the target is prepared instead,
# and docs/architecture/deploy.md -> "Restoring" carries the same two lines.
psql_scratch -d "${SCRATCH_DB}" -Atqc "DROP SCHEMA IF EXISTS public CASCADE" >/dev/null ||
	pgb_fail "could not clear the scratch database's public schema."

# --- 3. the actual restore ---------------------------------------------------
# --single-transaction: a restore that fails half way leaves NOTHING, so a
# "mostly restored" database can never be mistaken for a good one.
pgb_step "restoring…"
if gzip -cd "${DUMP}" |
	docker exec -i "${CONTAINER}" psql -U postgres -v ON_ERROR_STOP=1 \
		--single-transaction -q -d "${SCRATCH_DB}" -f - >"${WORK}/restore.log" 2>&1; then
	ok "restore completed with no errors (single transaction)"
else
	no "restore FAILED"
	tail -30 "${WORK}/restore.log" >&2
fi

if [ -s "${WORK}/restore.log" ]; then
	# psql -q still prints notices/warnings; they are not failures but they are
	# the first place a schema surprise shows up.
	pgb_step "psql output (${WORK}/restore.log):"
	sed 's/^/    /' "${WORK}/restore.log" | head -20
fi

# --- 4. does the restored database match the dump? ---------------------------
# Row counts are taken from the RESTORED server, table by table, and compared
# with the counts parsed out of the dump file. Two independent sources; if they
# agree, data actually landed.
psql_scratch -d "${SCRATCH_DB}" -At -F$'	' -c "
	SELECT table_schema || '.' || table_name,
	       (xpath('/row/c/text()',
	              query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name),
	                           false, true, '')))[1]::text::bigint
	  FROM information_schema.tables
	 WHERE table_schema IN ('public','drizzle') AND table_type = 'BASE TABLE'
	 ORDER BY 1;
" 2>/dev/null | sort >"${WORK}/live-counts.tsv" || true

live_tables="$(grep -c . <"${WORK}/live-counts.tsv" || true)"
live_rows="$(awk -F'\t' '{ t += $2 } END { print t + 0 }' <"${WORK}/live-counts.tsv")"

if [ "${live_tables}" = "${dump_tables}" ]; then
	ok "table count matches: ${live_tables} tables restored"
else
	no "table count differs: dump has ${dump_tables}, restored database has ${live_tables}"
	diff -u "${WORK}/dump-counts.tsv" "${WORK}/live-counts.tsv" | head -20 >&2 || true
fi

if diff -q "${WORK}/dump-counts.tsv" "${WORK}/live-counts.tsv" >/dev/null 2>&1; then
	ok "every table's row count matches the dump exactly (${live_rows} rows total)"
else
	no "row counts differ between the dump and the restored database"
	diff -u "${WORK}/dump-counts.tsv" "${WORK}/live-counts.tsv" | head -40 >&2 || true
fi

# --- 5. what a partial restore silently loses --------------------------------
mig_rows="$(psql_scratch -d "${SCRATCH_DB}" -Atqc \
	"SELECT count(*) FROM drizzle.__drizzle_migrations" 2>/dev/null || echo "")"
mig_files="$(find packages/db/migrations -maxdepth 1 -name '[0-9]*.sql' 2>/dev/null | wc -l | tr -d ' ')"
if [ -z "${mig_rows}" ]; then
	no "drizzle.__drizzle_migrations is MISSING — the next deploy would replay every
       migration from 0000 against this restored data"
elif [ "${mig_rows}" -eq 0 ]; then
	no "drizzle.__drizzle_migrations restored EMPTY — same replay hazard"
else
	ok "migration ledger restored: ${mig_rows} applied (repo has ${mig_files} migration files)"
	if [ "${mig_rows}" -lt "${mig_files}" ]; then
		pgb_warn "the dump predates ${mig_files}-${mig_rows} migration(s) in this checkout — expected if
       the backup is older than the current branch; a deploy would apply the rest."
	fi
fi

fks="$(psql_scratch -d "${SCRATCH_DB}" -Atqc \
	"SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
	  WHERE n.nspname = 'public' AND c.contype = 'f'" 2>/dev/null || echo 0)"
idx="$(psql_scratch -d "${SCRATCH_DB}" -Atqc \
	"SELECT count(*) FROM pg_indexes WHERE schemaname = 'public'" 2>/dev/null || echo 0)"
if [ "${fks:-0}" -gt 0 ] && [ "${idx:-0}" -gt 0 ]; then
	ok "structure restored too: ${fks} foreign keys, ${idx} indexes"
else
	no "schema objects missing (foreign keys: ${fks:-0}, indexes: ${idx:-0}) — this looks
       like a data-only or partial dump"
fi

users_rows="$(psql_scratch -d "${SCRATCH_DB}" -Atqc "SELECT count(*) FROM public.users" 2>/dev/null || echo 0)"
if [ "${users_rows:-0}" -gt 0 ]; then
	ok "queryable after restore: public.users has ${users_rows} row(s)"
else
	pgb_warn "public.users restored with 0 rows. Correct for an empty database, WRONG for a
       production dump — check which database this came from."
fi

# --- 6. tear the scratch down ------------------------------------------------
docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "${CONTAINER}"; then
	no "the scratch container ${CONTAINER} is still running — remove it by hand"
else
	ok "scratch database dropped (container removed)"
fi

pgb_log "passed=${pass} failed=${fail}"
pgb_storage_gap_notice

if [ "${fail}" -ne 0 ]; then
	pgb_fail "this dump is NOT a usable backup."
fi
printf '\n\033[1;32m[%s]\033[0m %s\n' "${PGB_TAG}" "RESTORE PROVEN — ${DUMP} restores to ${live_rows} rows across ${live_tables} tables."
