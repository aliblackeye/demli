#!/usr/bin/env bash
# Behavioural test for scripts/deploy.sh.
#
# WHY A FAKE DOCKER AND NOT A UNIT TEST
# ------------------------------------
# The bugs this guards against are ORDERING and REPORTING bugs, and neither is
# something an assertion on a single function can see: "did the schema migration
# run before anything started serving the new code", and "did a green /health let
# a broken download tree be reported as success". The only way to prove those is
# to run the whole script and check what it did, in the order it did it.
#
# So `docker` is replaced with a shell script that keeps its state in files, and
# deploy.sh is run for real against a scratch $SRV_ROOT. The test then asserts on
# the recorded command log.
#
# Run standalone or via `pnpm lint`:  bash scripts/test-deploy-migration.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
[ -n "${KEEP:-}" ] && echo "workdir: $WORK" || trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok() {
	printf '  ok   %s\n' "$1"
	pass=$((pass + 1))
}
no() {
	printf '  FAIL %s\n' "$1"
	fail=$((fail + 1))
}
expect() { # description, condition-already-evaluated ($? based)
	if [ "$2" = "0" ]; then ok "$1"; else no "$1"; fi
}

# --- the fake docker ---------------------------------------------------------
# Records every invocation to $DOCKER_LOG and simulates just enough state:
# named volumes and whether the stack is "up".
mkdir -p "$WORK/bin"
cat >"$WORK/bin/docker" <<'FAKE'
#!/usr/bin/env bash
log() { printf '%s\n' "$*" >>"$DOCKER_LOG"; }
log "docker $*"

state="$FAKE_STATE"
mkdir -p "$state/volumes"

case "$1" in
compose)
  # find the subcommand after the -f/--env-file flags
  shift
  sub=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --env-file|-f) shift 2; continue ;;
      *) sub="$1"; break ;;
    esac
  done
  case "$sub" in
    version) exit 0 ;;
    build) exit 0 ;;
    run)
      # `run --rm migrate` or the caddy validate
      case "$*" in
        *migrate*) [ -f "$state/migrate-fails" ] && exit 1; exit 0 ;;
        *validate*) exit 0 ;;
      esac
      exit 0 ;;
    up) touch "$state/new-stack-up"; exit 0 ;;
    down) rm -f "$state/new-stack-up"; exit 0 ;;
    ps) exit 0 ;;
    exec)
      [ -f "$state/new-stack-up" ] || exit 1
      case "$*" in
        *sha256sum*) cat "$state/caddy-hash" 2>/dev/null || exit 1; exit 0 ;;
        *2019/config*) cat "$state/caddy-config" 2>/dev/null || exit 1; exit 0 ;;
        *health*) [ -f "$state/api-unhealthy" ] && exit 1; exit 0 ;;
      esac
      exit 0 ;;
    logs) exit 0 ;;
  esac
  exit 0 ;;
ps) exit 0 ;;
stop) exit 0 ;;
rm) exit 0 ;;
pull) exit 0 ;;
volume)
  case "$2" in
    inspect) [ -f "$state/volumes/$3" ] ;;
    create) touch "$state/volumes/$3" ;;
  esac
  exit $? ;;
run)
  # `docker run … pg_dump …` is the pre-migration backup (scripts/backup-db.sh
  # runs the client in a pinned container). Emit a STRUCTURALLY REAL dump so the
  # backup script's own integrity/shape checks execute for real instead of being
  # stubbed out — the point of the exercise is that a broken backup stops the
  # deploy, which cannot be shown if the backup is fake all the way down.
  case "$*" in
    *pg_dump*)
      [ -f "$state/backup-fails" ] && exit 1
      cat <<'DUMPEOF'
--
-- PostgreSQL database dump
--
CREATE SCHEMA drizzle;
CREATE TABLE public.users (id uuid NOT NULL);
CREATE TABLE public.messages (id uuid NOT NULL);
CREATE TABLE public.friend_groups (id uuid NOT NULL);
CREATE TABLE public.channels (id uuid NOT NULL);
CREATE TABLE drizzle.__drizzle_migrations (id integer NOT NULL);
COPY public.users (id) FROM stdin;
11111111-1111-1111-1111-111111111111
\.
COPY public.messages (id) FROM stdin;
\.
--
-- PostgreSQL database dump complete
--
DUMPEOF
      exit 0 ;;
  esac
  exit 0 ;;
network) exit 0 ;;
image)
  case "$2" in
    prune) exit 0 ;;
    inspect) exit 1 ;;
    rm) exit 0 ;;
  esac
  exit 0 ;;
builder) exit 0 ;;
esac
exit 0
FAKE
chmod +x "$WORK/bin/docker"

# curl: /health and the feed URLs answer 200 unless told otherwise.
cat >"$WORK/bin/curl" <<'FAKE'
#!/usr/bin/env bash
url="${@: -1}"
if [ -f "$FAKE_STATE/feed-404" ] && case "$url" in *"/dl/"*) true ;; *) false ;; esac; then
  case "$*" in *"%{http_code}"*) echo "404" ;; esac
  exit 22
fi
case "$*" in
  *"%{http_code}"*) echo "200" ;;
  *) echo "ok" ;;
esac
exit 0
FAKE
chmod +x "$WORK/bin/curl"

# envsubst stub so the preflight passes without the real tool.
printf '#!/usr/bin/env bash\ncat\n' >"$WORK/bin/envsubst"
chmod +x "$WORK/bin/envsubst"

# No-op sleep. deploy.sh's retry loops are 30 x 2s for health and again for the
# public edge; a failing scenario would otherwise burn two minutes of wall clock
# per run and make this too slow to keep in `pnpm lint` — which is the same as
# not having it.
printf '#!/usr/bin/env bash\nexit 0\n' >"$WORK/bin/sleep"
chmod +x "$WORK/bin/sleep"

export PATH="$WORK/bin:$PATH"

# --- scenario runner ---------------------------------------------------------
# Builds a pristine scratch world, applies the scenario's setup, runs deploy.sh.
run_deploy() { # $1 = scenario name, $2 = setup function
	SCEN="$WORK/$1"
	rm -rf "$SCEN"
	mkdir -p "$SCEN/state/volumes" "$SCEN/srv"
	export FAKE_STATE="$SCEN/state"
	export DOCKER_LOG="$SCEN/docker.log"
	: >"$DOCKER_LOG"

	# Caddy staleness oracle: make the in-container hash equal the repo's, so the
	# Caddy section is a no-op and does not distort the ordering under test.
	sha256sum "$REPO_ROOT/Caddyfile" | awk '{print $1}' >"$FAKE_STATE/caddy-hash"
	# Every expected vhost, quoted, so the vhost proof passes.
	{
		printf '{"apps":{"http":{"servers":{"srv0":{"routes":['
		for h in "" www. app. api. ws. livekit.; do printf '{"match":[{"host":["%s%s"]}]},' "$h" "example.test"; done
		printf ']}}}}}'
	} >"$FAKE_STATE/caddy-config"

	"$2" # scenario setup

	(
		cd "$REPO_ROOT" &&
			env SRV_ROOT="$SCEN/srv" \
				ENV_FILE="$SCEN/env.prod" \
				DEPLOY_SKIP_DNS_CHECK=1 \
				DL_DESKTOP_DIR="$SCEN/srv/demli-dl/desktop" \
				DL_MOBILE_DIR="$SCEN/srv/demli-dl/mobile" \
				bash scripts/deploy.sh
	) >"$SCEN/out.log" 2>&1
	DEPLOY_STATUS=$?
	return 0
}

write_env() {
	cat >"$SCEN/env.prod" <<EOF
DOMAIN=example.test
ACME_EMAIL=a@example.test
DATABASE_URL=postgresql://real:real@db.example.test/postgres
LIVEKIT_API_KEY=realkey
LIVEKIT_API_SECRET=realsecret
REDIS_PASSWORD=realpassword
APP_ENV=production
EOF
}

seed_feed() {
	mkdir -p "$SCEN/srv/demli-dl/desktop" "$SCEN/srv/demli-dl/mobile"
	echo "manifest" >"$SCEN/srv/demli-dl/desktop/demli.yml"
	echo "apk" >"$SCEN/srv/demli-dl/mobile/demli.apk"
}

grep_log() { grep -q "$1" "$SCEN/docker.log"; }

# Index of the first line matching $1 in the docker log (0 if absent).
line_of() { grep -n "$1" "$SCEN/docker.log" 2>/dev/null | head -1 | cut -d: -f1; }

echo "== scenario 1: fresh server, nothing published yet =="
setup1() { write_env; }
run_deploy s1 setup1
[ "$DEPLOY_STATUS" = "0" ]
expect "deploy succeeds with an empty download tree" "$?"
! grep_log "docker rm "
expect "nothing is removed" "$?"
grep -q "WARN" "$WORK/s1/out.log"
expect "the missing APK is reported as a warning, not a failure" "$?"

echo ""
echo "== scenario 2: normal deploy with a published feed =="
setup2() {
	write_env
	seed_feed
}
run_deploy s2 setup2
[ "$DEPLOY_STATUS" = "0" ]
expect "deploy succeeds" "$?"
migrate_at="$(line_of 'run --rm migrate')"
up_at="$(line_of 'up -d --remove-orphans')"
backup_at="$(line_of 'pg_dump')"
[ -n "$migrate_at" ] && [ -n "$up_at" ] && [ "$migrate_at" -lt "$up_at" ]
expect "ORDER: database migrations run BEFORE the stack starts" "$?"
[ -n "$backup_at" ] && [ -n "$migrate_at" ] && [ "$backup_at" -lt "$migrate_at" ]
expect "ORDER: the database backup is taken BEFORE the migration" "$?"
ls "$WORK/s2/srv/demli-backups"/demli-*-predeploy.sql.gz >/dev/null 2>&1
expect "a labelled pre-deploy dump is on disk afterwards" "$?"
gzip -t "$WORK"/s2/srv/demli-backups/demli-*-predeploy.sql.gz 2>/dev/null
expect "that dump is a valid gzip stream" "$?"
grep -q "Mobile APK OK" "$WORK/s2/out.log"
expect "the advertised APK is confirmed present" "$?"

echo ""
echo "== scenario 3: schema migration fails -> nothing starts =="
setup3() {
	write_env
	seed_feed
	touch "$FAKE_STATE/migrate-fails"
}
run_deploy s3 setup3
[ "$DEPLOY_STATUS" != "0" ]
expect "deploy fails loudly" "$?"
! grep_log "up -d --remove-orphans"
expect "the stack is never started against an unmigrated schema" "$?"

echo ""
echo "== scenario 4: API never becomes healthy -> deploy fails =="
setup4() {
	write_env
	seed_feed
	touch "$FAKE_STATE/api-unhealthy"
}
run_deploy s4 setup4
[ "$DEPLOY_STATUS" != "0" ]
expect "deploy fails instead of reporting a healthy stack" "$?"

echo ""
echo "== scenario 5: files on disk but the feed 404s -> deploy must NOT report success =="
setup5() {
	write_env
	seed_feed
	touch "$FAKE_STATE/feed-404"
}
run_deploy s5 setup5
[ "$DEPLOY_STATUS" != "0" ]
expect "deploy fails when a present artifact is not served" "$?"
grep -q "NOT SERVED" "$WORK/s5/out.log"
expect "it says which URL did not serve" "$?"

echo ""
echo "== scenario 6: the pre-migration backup fails -> the schema is never touched =="
# The whole point of ordering the backup first: if the recovery point cannot be
# taken, the irreversible step must not run. A deploy that warns and migrates
# anyway is indistinguishable from having no backup at all.
setup6() {
	write_env
	seed_feed
	touch "$FAKE_STATE/backup-fails"
}
run_deploy s6 setup6
[ "$DEPLOY_STATUS" != "0" ]
expect "deploy fails when the backup cannot be taken" "$?"
! grep_log "run --rm migrate"
expect "migrations NEVER run without a backup" "$?"
! grep_log "up -d --remove-orphans"
expect "the stack is not restarted either" "$?"
grep -q "pre-migration backup FAILED" "$WORK/s6/out.log"
expect "it says why it stopped" "$?"

echo ""
echo "== scenario 7: DEPLOY_SKIP_BACKUP=1 is possible, loud, and per-run =="
setup7() {
	write_env
	seed_feed
	touch "$FAKE_STATE/backup-fails"
	export DEPLOY_SKIP_BACKUP=1
}
run_deploy s7 setup7
unset DEPLOY_SKIP_BACKUP
[ "$DEPLOY_STATUS" = "0" ]
expect "an explicit override still deploys" "$?"
grep -q "NO recovery point" "$WORK/s7/out.log"
expect "the override says exactly what was given up" "$?"
! grep_log "pg_dump"
expect "no backup is attempted when it is skipped" "$?"

echo ""
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
