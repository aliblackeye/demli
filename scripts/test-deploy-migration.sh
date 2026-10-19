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
    up)
      # LiveKit model: "$state/livekit-mounted" is the config file the running
      # livekit container has mounted (= what its process loaded). A fresh
      # container mounts whatever is on disk; a force-recreate re-mounts it.
      case "$*" in
        *force-recreate*livekit*) cp deploy/livekit.runtime.yaml "$state/livekit-mounted" ;;
        *force-recreate*) ;;
        *) [ -f "$state/livekit-mounted" ] || cp deploy/livekit.runtime.yaml "$state/livekit-mounted" ;;
      esac
      touch "$state/new-stack-up"; exit 0 ;;
    down) rm -f "$state/new-stack-up"; exit 0 ;;
    ps) exit 0 ;;
    exec)
      [ -f "$state/new-stack-up" ] || exit 1
      case "$*" in
        *" livekit sha256sum"*)
          [ -f "$state/livekit-mounted" ] || exit 1
          # A config the SFU refuses to boot on leaves no running container.
          if [ -f "$state/livekit-rejects-webhook" ] && grep -q "hooks/livekit" "$state/livekit-mounted"; then exit 1; fi
          sha256sum "$state/livekit-mounted" | awk '{print $1 "  /etc/livekit/livekit.yaml"}'; exit 0 ;;
        *" livekit cat "*) cat "$state/livekit-mounted" 2>/dev/null || exit 1; exit 0 ;;
        *" livekit wget"*"hooks/livekit"*)
          if [ -f "$state/webhook-unreachable" ]; then echo "wget: bad address 'api'" >&2; exit 1; fi
          echo "wget: server returned error: HTTP/1.1 401 Unauthorized" >&2; exit 1 ;;
        *" livekit wget"*)
          if [ -f "$state/livekit-rejects-webhook" ] && grep -q "hooks/livekit" "$state/livekit-mounted"; then exit 1; fi
          echo "OK"; exit 0 ;;
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

# envsubst stand-in: substitutes exactly the ${NAME} placeholders named in its
# SHELL-FORMAT argument, from the environment — the real tool's contract, so the
# render checks in deploy.sh run against a real render. `envsubst-broken` makes
# it a plain `cat` (every placeholder left as literal text).
cat >"$WORK/bin/envsubst" <<'FAKE'
#!/usr/bin/env bash
[ -f "$FAKE_STATE/envsubst-broken" ] && exec cat
content="$(cat; printf x)"
content="${content%x}"
for name in $(printf '%s' "${1:-}" | grep -oE '[A-Za-z_][A-Za-z0-9_]*'); do
  value="${!name-}"
  content="${content//"\${$name}"/$value}"
done
printf '%s' "$content"
FAKE
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
grep -qE '^[[:space:]]+api_key: "?realkey"?[[:space:]]*$' "$REPO_ROOT/deploy/livekit.runtime.yaml"
expect "the rendered LiveKit webhook signs with LIVEKIT_API_KEY" "$?"
! grep -q "realsecret" "$REPO_ROOT/deploy/livekit.runtime.yaml"
expect "the LiveKit SECRET is not in the rendered config" "$?"
! grep_log "force-recreate livekit"
expect "an unchanged LiveKit config does NOT recreate the SFU (no call is dropped)" "$?"
grep -q "Webhook reachable from the SFU" "$WORK/s2/out.log"
expect "the SFU -> API webhook path is proven" "$?"

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
echo "== scenario 8: LiveKit runs an OLDER config -> recreated once, after the API is healthy =="
# The trap the LiveKit section closes: compose cannot see a changed bind-mounted
# file, so without an explicit recreate the webhook would never take effect.
setup8() {
	write_env
	seed_feed
	printf 'port: 7880\n# the config the old container booted with\n' >"$FAKE_STATE/livekit-mounted"
}
run_deploy s8 setup8
[ "$DEPLOY_STATUS" = "0" ]
expect "deploy succeeds" "$?"
[ "$(grep -c 'force-recreate livekit' "$WORK/s8/docker.log")" = "1" ]
expect "livekit is recreated exactly once" "$?"
health_at="$(line_of 'exec -T api node')"
lk_at="$(line_of 'force-recreate livekit')"
[ -n "$health_at" ] && [ -n "$lk_at" ] && [ "$health_at" -lt "$lk_at" ]
expect "ORDER: the SFU is recreated only AFTER the API is healthy" "$?"
cmp -s "$FAKE_STATE/livekit-mounted" "$REPO_ROOT/deploy/livekit.runtime.yaml"
expect "the running LiveKit now has the rendered config" "$?"
! grep -q "force-recreate caddy" "$WORK/s8/docker.log"
expect "nothing else is recreated with it" "$?"

echo ""
echo "== scenario 9: the new LiveKit config does not boot -> rolled back, deploy fails =="
setup9() {
	write_env
	seed_feed
	printf 'port: 7880\n# known-good config\n' >"$FAKE_STATE/livekit-mounted"
	touch "$FAKE_STATE/livekit-rejects-webhook"
}
run_deploy s9 setup9
[ "$DEPLOY_STATUS" != "0" ]
expect "deploy fails loudly" "$?"
grep -q "ROLLING BACK" "$WORK/s9/out.log"
expect "it says it rolled back" "$?"
grep -q "known-good config" "$REPO_ROOT/deploy/livekit.runtime.yaml" &&
	grep -q "known-good config" "$FAKE_STATE/livekit-mounted"
expect "the SFU is back on the config it was running before" "$?"
[ "$(grep -c 'force-recreate livekit' "$WORK/s9/docker.log")" = "2" ]
expect "exactly one recreate forward and one back" "$?"

echo ""
echo "== scenario 10: a placeholder the envsubst list misses -> nothing is touched =="
setup10() {
	write_env
	seed_feed
	touch "$FAKE_STATE/envsubst-broken"
	sha256sum "$REPO_ROOT/deploy/livekit.runtime.yaml" | awk '{print $1}' >"$SCEN/runtime-before"
}
run_deploy s10 setup10
[ "$DEPLOY_STATUS" != "0" ]
expect "deploy fails" "$?"
grep -q "still contains placeholders" "$WORK/s10/out.log"
expect "it names the unrendered placeholders" "$?"
! grep_log " build" && ! grep_log "up -d"
expect "nothing is built or started" "$?"
[ "$(sha256sum "$REPO_ROOT/deploy/livekit.runtime.yaml" | awk '{print $1}')" = "$(cat "$WORK/s10/runtime-before")" ]
expect "the existing runtime config is not replaced" "$?"

echo ""
echo "== scenario 11: the SFU cannot reach the webhook -> deploy must NOT report success =="
setup11() {
	write_env
	seed_feed
	touch "$FAKE_STATE/webhook-unreachable"
}
run_deploy s11 setup11
[ "$DEPLOY_STATUS" != "0" ]
expect "deploy fails when the join check would be silently off" "$?"
grep -q "cannot deliver to http://api:4000/hooks/livekit" "$WORK/s11/out.log"
expect "it says which URL is unreachable" "$?"

echo ""
echo "== scenario 12: DEPLOY_SKIP_LIVEKIT_RECREATE=1 defers the SFU restart, loudly =="
setup12() {
	write_env
	seed_feed
	printf 'port: 7880\n# old\n' >"$FAKE_STATE/livekit-mounted"
	export DEPLOY_SKIP_LIVEKIT_RECREATE=1
}
run_deploy s12 setup12
unset DEPLOY_SKIP_LIVEKIT_RECREATE
[ "$DEPLOY_STATUS" = "0" ]
expect "the deploy completes" "$?"
! grep_log "force-recreate livekit"
expect "the SFU is not restarted" "$?"
grep -q "NOT in effect" "$WORK/s12/out.log"
expect "it says the new config (and the join check) is not in effect" "$?"

echo ""
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
