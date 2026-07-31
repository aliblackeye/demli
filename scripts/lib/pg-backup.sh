#!/usr/bin/env bash
# Shared plumbing for the database backup + restore-proof scripts.
#
# SOURCED, never executed:
#     . "$(dirname "${BASH_SOURCE[0]}")/lib/pg-backup.sh"
#
# Two scripts use it — scripts/backup-db.sh (takes the dump) and
# scripts/restore-db-verify.sh (proves the dump can be restored). They share the
# connection handling and the dump parser on purpose: a backup that is inspected
# one way and verified another is how a verification ends up agreeing with itself
# instead of with reality.
#
# THE PASSWORD NEVER REACHES A COMMAND LINE. The connection string is parsed here
# into the standard libpq environment variables (PGHOST/PGUSER/PGPASSWORD/…) and
# every tool is invoked with NO connection argument at all. That is the same rule
# scripts/lib/remote-ssh.sh enforces for SSH, for the same reason: an argument
# vector is world-readable (`ps`, /proc/<pid>/cmdline) — including for processes
# inside a container, which show up in the host's process list in full.
# `pnpm lint:deploy` fails if a `psql`/`pg_dump` call ever grows a "$DATABASE_URL".

# --- logging ----------------------------------------------------------------
# PGB_TAG is set by the sourcing script so its output is attributable.
pgb_log() { printf '\n\033[1;36m[%s]\033[0m %s\n' "${PGB_TAG:-db}" "$*"; }
pgb_step() { printf '  %s\n' "$*"; }
pgb_ok() { printf '  \033[1;32mok  \033[0m %s\n' "$*"; }
pgb_bad() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*" >&2; }
pgb_warn() { printf '\033[1;33m[%s] WARN:\033[0m %s\n' "${PGB_TAG:-db}" "$*" >&2; }
pgb_fail() {
	printf '\n\033[1;31m[%s] ERROR:\033[0m %s\n' "${PGB_TAG:-db}" "$*" >&2
	exit 1
}

# --- env file ---------------------------------------------------------------
# Same idiom as scripts/deploy.sh: KEY=VALUE lines only, comments ignored.
# Values already present in the environment WIN — deploy.sh has sourced .env.prod
# before calling us, and a test harness must be able to override the target.
pgb_load_env_file() {
	local file="${1:-}"
	[ -n "${file}" ] || return 0
	[ -f "${file}" ] || return 0
	local had_url="${DATABASE_URL:-}"
	set -a
	# shellcheck disable=SC1090
	. "${file}"
	set +a
	[ -n "${had_url}" ] && DATABASE_URL="${had_url}"
	export DATABASE_URL
	return 0
}

# --- connection string ------------------------------------------------------
# %XX -> byte. `printf %b` on a string whose '%' are turned into '\x' is the
# standard shell urldecode; a literal backslash inside a password would be
# mangled by it, which is why the decoded value is only ever used as an env var
# (never re-quoted into a shell command).
pgb_urldecode() {
	local s="${1//+/ }"
	printf '%b' "${s//%/\\x}"
}

# Parse DATABASE_URL into the libpq environment. Exports PGHOST, PGPORT, PGUSER,
# PGPASSWORD, PGDATABASE, PGSSLMODE, PGCONNECT_TIMEOUT.
pgb_export_libpq_env() {
	local url="${DATABASE_URL:-}"
	[ -n "${url}" ] || pgb_fail "DATABASE_URL is not set (env, or ENV_FILE=${ENV_FILE:-.env.prod})."

	case "${url}" in
	postgres://* | postgresql://*) ;;
	*) pgb_fail "DATABASE_URL is not a postgres:// URL." ;;
	esac

	# Reject the placeholders shipped in .env.prod.example — a copied-but-unfilled
	# env file must not produce a "successful" backup of nothing.
	case "${url}" in
	*YOUR_DB_PASSWORD* | *YOUR_PROJECT_REF* | *REPLACE_WITH*)
		pgb_fail "DATABASE_URL is still a placeholder from .env.prod.example."
		;;
	esac

	local rest="${url#*://}" creds="" hostpart="" query=""
	case "${rest}" in
	*@*)
		creds="${rest%%@*}"
		hostpart="${rest#*@}"
		;;
	*) hostpart="${rest}" ;;
	esac
	case "${hostpart}" in
	*\?*)
		query="${hostpart#*\?}"
		hostpart="${hostpart%%\?*}"
		;;
	esac

	local hostport="${hostpart%%/*}" dbname=""
	case "${hostpart}" in
	*/*) dbname="${hostpart#*/}" ;;
	esac

	local host="${hostport}" port=""
	case "${hostport}" in
	\[*) # bracketed IPv6 literal
		host="${hostport%%]*}"
		host="${host#[}"
		local after="${hostport#*]}"
		if [ "${after}" != "${after#:}" ]; then port="${after#:}"; fi
		;;
	*:*)
		host="${hostport%%:*}"
		port="${hostport##*:}"
		;;
	esac

	local user="" pass=""
	if [ -n "${creds}" ]; then
		case "${creds}" in
		*:*)
			user="${creds%%:*}"
			pass="${creds#*:}"
			;;
		*) user="${creds}" ;;
		esac
	fi

	[ -n "${host}" ] || pgb_fail "DATABASE_URL has no host."
	[ -n "${dbname}" ] || pgb_fail "DATABASE_URL has no database name (…/<dbname>)."

	local sslmode=""
	if [ -n "${query}" ]; then
		sslmode="$(printf '%s' "${query}" | tr '&' '\n' | sed -n 's/^sslmode=//p' | head -1)"
		# Anything else in the query string is NOT honoured. Say so rather than
		# silently connecting differently than the app does.
		# `|| true`: with only `sslmode` in the query string — which is the
		# PRODUCTION shape (…?sslmode=require) — grep matches nothing and exits 1,
		# and under `set -e` that aborted the whole backup before it started. Found
		# by running this against a URL that had a query string at all; the first
		# green run did not have one.
		local other
		other="$(printf '%s' "${query}" | tr '&' '\n' | grep -v '^sslmode=' | cut -d= -f1 | tr -d '\r' | tr '\n' ' ' || true)"
		other="${other%% }"
		if [ -n "${other}" ]; then
			pgb_warn "ignoring unsupported connection parameters: ${other}"
		fi
	fi

	PGHOST="${host}"
	PGPORT="${port:-5432}"
	PGUSER="$(pgb_urldecode "${user:-postgres}")"
	PGPASSWORD="$(pgb_urldecode "${pass}")"
	PGDATABASE="$(pgb_urldecode "${dbname}")"
	PGCONNECT_TIMEOUT="${PGB_CONNECT_TIMEOUT:-15}"
	export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGCONNECT_TIMEOUT
	if [ -n "${sslmode}" ]; then
		PGSSLMODE="${sslmode}"
		export PGSSLMODE
	fi
}

# Host with the middle label masked: db.abcdef.supabase.co -> db.****.supabase.co
# Enough to tell two environments apart in a log, not enough to be a credential.
pgb_masked_target() {
	local masked
	masked="$(printf '%s' "${PGHOST}" | sed 's/^\([^.]*\)\.[^.]*\.\(.*\)$/\1.****.\2/')"
	printf '%s:%s/%s' "${masked}" "${PGPORT}" "${PGDATABASE}"
}

# --- which pg_dump/psql binary ----------------------------------------------
# auto = a pinned container image when Docker is available, the host binaries
# otherwise. Docker first on purpose: pg_dump REFUSES to dump a server newer than
# itself, and "whatever pg_dump the distro happens to ship" is exactly the kind of
# environment difference that makes a backup work on one box and not another.
# Override the image when the managed Postgres is upgraded past it.
pgb_pg_runner() {
	local mode="${BACKUP_PG_MODE:-auto}"
	case "${mode}" in
	local | docker)
		printf '%s' "${mode}"
		return 0
		;;
	auto) ;;
	*) pgb_fail "BACKUP_PG_MODE must be auto|local|docker (got '${mode}')." ;;
	esac
	if command -v docker >/dev/null 2>&1; then printf 'docker'; else printf 'local'; fi
}

pgb_pg_image() { printf '%s' "${BACKUP_PG_IMAGE:-postgres:17-alpine}"; }

# Run a postgres client tool against DATABASE_URL. `-e NAME` (no value) passes the
# variable BY NAME — the password is copied from this process's environment into
# the container's and never appears in any argument vector.
pgb_run_pg() {
	local runner
	runner="$(pgb_pg_runner)"
	if [ "${runner}" = "local" ]; then
		command -v "$1" >/dev/null 2>&1 ||
			pgb_fail "$1 not found on PATH. Install the postgresql-client package, or set BACKUP_PG_MODE=docker."
		"$@"
	else
		command -v docker >/dev/null 2>&1 ||
			pgb_fail "docker not found and BACKUP_PG_MODE=docker."
		# shellcheck disable=SC2086 # BACKUP_PG_DOCKER_ARGS is a deliberate word list
		docker run --rm ${BACKUP_PG_DOCKER_ARGS:-} \
			-e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE \
			-e PGSSLMODE -e PGCONNECT_TIMEOUT \
			"$(pgb_pg_image)" "$@"
	fi
}

# --- dump inspection --------------------------------------------------------
# A plain pg_dump writes each table's data as
#     COPY public.users (id, …) FROM stdin;
#     <one line per row>
#     \.
# so the row count per table can be read straight out of the artifact — without a
# database, and without asking the source again. That is the number
# restore-db-verify.sh compares the RESTORED database against: dump says N rows,
# restored table must have exactly N.
#
# Data lines can never be mistaken for a header or a terminator: COPY text format
# escapes backslashes, so no data line is exactly "\.", and the `!intab` guard
# keeps a row whose first field starts with "COPY " from opening a new block.
pgb_dump_table_stats() {
	gzip -cd "$1" | awk '
		!intab && /^COPY .* FROM stdin;$/ {
			name = $2
			gsub(/"/, "", name)
			if (!(name in seen)) { seen[name] = 1; order[++n] = name }
			intab = 1
			next
		}
		intab && /^\\\.$/ { intab = 0; next }
		intab { rows[name]++; next }
		END { for (i = 1; i <= n; i++) printf "%s\t%d\n", order[i], rows[order[i]] + 0 }
	'
}

# pg_dump writes this trailer as its LAST action. Its presence is the only cheap
# proof that the dump is COMPLETE — a dump truncated by a dropped connection, a
# full disk or an OOM kill is still valid gzip and still full of plausible SQL.
# (Captured into a variable rather than piped into `grep -q`: an early-exiting
# grep SIGPIPEs the decompressor, and `set -o pipefail` then reports the pipeline
# as failed exactly when the trailer WAS found.)
pgb_dump_is_complete() {
	local tail_lines
	tail_lines="$(gzip -cd "$1" 2>/dev/null | tail -5)"
	case "${tail_lines}" in
	*"PostgreSQL database dump complete"*) return 0 ;;
	*) return 1 ;;
	esac
}

# --- the honest scope note --------------------------------------------------
# Printed by BOTH scripts, every run. `pg_dump` copies the database and nothing
# else; the product's user-visible media lives in Supabase Storage buckets, which
# this artifact does not contain and cannot restore. Believing otherwise is the
# specific way a team with backups still loses every avatar and attachment.
pgb_storage_gap_notice() {
	cat <<'EOF'

  SCOPE — what this backup does NOT contain:
    * Supabase STORAGE buckets: attachments (message media), avatars (profile
      photos AND banners). The database keeps only the object paths/URLs, so a
      restore from this dump gives you rows pointing at files that are gone.
    * Supabase auth/storage system schemas — only `public` and `drizzle` are
      dumped (see scripts/backup-db.sh for why).
    * Redis (presence, fan-out bus) — derived state, intentionally not backed up.
    * The VPS itself (Caddy certs, /srv/demli-dl artifacts) — rebuildable.
  Bucket contents must be copied separately; see docs/architecture/deploy.md
  -> "Database backups".
EOF
}
