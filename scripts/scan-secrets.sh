#!/usr/bin/env bash
# Secret sweep over the ENTIRE git history (all refs), for the open-source
# pre-flight. Run this before flipping the repo to public, and again after any
# batch of commits that touches scripts/, deploy config, or .claude/reports/.
#
#   bash scripts/scan-secrets.sh
#
# Exit code gates ONLY on the two binary checks — step 1 (a secret-shaped file
# tracked in history) and step 4 (a .gitignore hole). Steps 2/3/5 are review
# aids that always print: step 2 legitimately matches every placeholder and
# ${VAR} expansion in the tree, so gating on it would make this script
# permanently red and therefore ignored.
#
# What it does NOT do — read docs/security/opensource-preflight.md:
#   * It cannot see inside images. The one real leak found in the 2026-07-29
#     sweep was a password rendered in a committed PNG. Committed screenshots
#     must still be reviewed BY EYE (step 5).
#   * It reports LOCATION ONLY. Values are masked so the output itself is safe
#     to paste into a report.
set -uo pipefail

cd "$(dirname "$0")/.."

# Exclusions below, each for a different reason:
#
#  - TESTS. `apps/api/src/__tests__/cors-credentials.test.ts` is a test ABOUT
#    credential handling, not a file that holds one. Tests are the one category
#    that talks about secrets by name as a matter of course.
#  - Two paths BY EXACT NAME: this script and the pre-flight doc, both of which
#    match on the word "secret" in their own filename.
#
# Left in, step 1 was permanently red, which is worse than not running it at all
# — a gate that always fails teaches you to skip reading it, and a real hit would
# have been one line of noise among the noise it already prints.
#
# The exclusions stay NARROW on purpose. An earlier attempt filtered by file
# EXTENSION instead ("source files are never secrets"), which quietly let
# `config/secrets.json` through — a real secret store, dropped by a rule written
# to silence a test file. Exclude by role, never by extension.
echo "== 1. Secret-shaped paths ever tracked (any commit, any ref) =="
paths=$(git log --all --full-history --pretty=format: --name-only \
  | sort -u \
  | grep -iE 'env\.deploy|env\.mobile-signing|env\.prod$|env\.local|\.env$|/\.env|secret|credential|\.pem$|\.key$|\.p12$|\.pfx$|\.p8$|\.jks$|keystore|id_rsa|id_ed25519|known_hosts|service.account|settings\.local|token\.txt' \
  | grep -viE '\.example$' \
  | grep -viE '(^|/)__tests__/|\.test\.[a-z]+$|\.spec\.[a-z]+$' \
  | grep -vxF 'scripts/scan-secrets.sh' \
  | grep -vxF 'docs/security/opensource-preflight.md' || true)
if [ -n "$paths" ]; then
  echo "!! secret-shaped paths in history:"
  echo "$paths"
else
  echo "ok — only *.example files"
fi

echo
echo "== 2. Credential patterns in history content (values masked) =="
echo "   (REVIEW AID, not a gate — placeholders and \${VAR} expansions match here too.)"
hits=$(git log -p --all --no-color --no-renames 2>/dev/null | awk '
function mask(s,   p, tail) {
  p = match(s, /[:=]/)
  if (p > 0) { tail = substr(s, p + 1); gsub(/^[ \t"'"'"']+/, "", tail)
               return substr(s, 1, p) " ***len=" length(tail) }
  return "***len=" length(s)
}
function hit(name,   line) {
  line = $0; sub(/^[+-]/, "", line); gsub(/^[ \t]+/, "", line)
  if (length(line) > 200) line = substr(line, 1, 200)
  print name "\t" commit "\t" file "\t" mask(line)
}
/^commit [0-9a-f]{40}/ { commit = substr($2, 1, 10); next }
/^\+\+\+ b\//          { file = substr($0, 7); next }
!/^[+-]/               { next }
/^(\+\+\+|---)/        { next }

/-----BEGIN [A-Z ]*PRIVATE KEY/            { hit("PRIVATE_KEY"); next }
/-----BEGIN OPENSSH/                       { hit("OPENSSH_KEY"); next }
/(ssh-rsa|ssh-ed25519|ecdsa-sha2) AAAA/    { hit("SSH_PUBKEY"); next }
/eyJ[A-Za-z0-9_-]{15,}\.eyJ/               { hit("JWT"); next }
/AIza[0-9A-Za-z_-]{30,}/                   { hit("GOOGLE_API_KEY"); next }
/(ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}/       { hit("GITHUB_TOKEN"); next }
/github_pat_[A-Za-z0-9_]{20,}/             { hit("GITHUB_PAT"); next }
/AKIA[0-9A-Z]{16}/                         { hit("AWS_KEY"); next }
/xox[baprs]-[A-Za-z0-9-]{10,}/             { hit("SLACK_TOKEN"); next }
/sk-[A-Za-z0-9_-]{20,}/                    { hit("OPENAI_LIKE_KEY"); next }
/sk_(live|test)_[A-Za-z0-9]{10,}/          { hit("STRIPE_KEY"); next }
/service_role/                             { hit("SUPABASE_SERVICE_ROLE"); next }
/private_key_id/                           { hit("GCP_SA_JSON"); next }
/iam\.gserviceaccount\.com/                { hit("GCP_SA_EMAIL"); next }
/https:\/\/[0-9a-f]{16,}@[A-Za-z0-9.-]*ingest/ { hit("SENTRY_DSN"); next }
/(postgres|postgresql):\/\/[^ :\/]+:[^ @]+@/   { hit("PG_URL_WITH_PW"); next }
/redis:\/\/[^ :\/]*:[^ @]+@/               { hit("REDIS_URL_WITH_PW"); next }
/(amqp|mongodb(\+srv)?|mysql):\/\/[^ :\/]+:[^ @]+@/ { hit("DB_URL_WITH_PW"); next }
/(^|[^A-Z_])(JWT_SECRET|SESSION_SECRET|COOKIE_SECRET)[ \t]*[:=]/ { hit("JWT_SECRET"); next }
/LIVEKIT_(API_)?(KEY|SECRET)[ \t]*[:=]/    { hit("LIVEKIT_CRED"); next }
/(EXPO_TOKEN|EAS_TOKEN|EAS_WEBHOOK_SECRET)[ \t]*[:=]/ { hit("EXPO_CRED"); next }
/(KEYSTORE_PASSWORD|KEY_PASSWORD|STORE_PASSWORD|KEY_ALIAS)[ \t]*[:=]/ { hit("KEYSTORE_CRED"); next }
/(DEPLOY_PASS|SSHPASS|SSH_PASS|VPS_PASS|ROOT_PASS)[ \t]*[:=]/ { hit("DEPLOY_PASS"); next }
/sshpass[ \t]+-p/                          { hit("SSHPASS_INLINE"); next }
/(POSTGRES_PASSWORD|PGPASSWORD|DB_PASSWORD|REDIS_PASSWORD)[ \t]*[:=]/ { hit("DB_PASSWORD"); next }
/(SMTP_PASS|MAIL_PASS|RESEND_API_KEY|SENDGRID_API_KEY)[ \t]*[:=]/ { hit("MAIL_CRED"); next }
/(YOUTUBE_API_KEY|YT_API_KEY)[ \t]*[:=]/   { hit("YOUTUBE_KEY"); next }
/(GOOGLE_CLIENT_SECRET|OAUTH_CLIENT_SECRET|CLIENT_SECRET)[ \t]*[:=]/ { hit("OAUTH_CLIENT_SECRET"); next }
/(SUPABASE_SERVICE_KEY|S3_SECRET|MINIO_(ROOT_PASSWORD|SECRET_KEY)|AWS_SECRET_ACCESS_KEY)[ \t]*[:=]/ { hit("STORAGE_CRED"); next }
/(APPLE_[A-Z_]*(PASSWORD|KEY)|ASC_KEY|CSC_KEY_PASSWORD)[ \t]*[:=]/ { hit("APPLE_CRED"); next }
' | sort -u)

if [ -n "$hits" ]; then
  echo "$hits"
else
  echo "ok — no pattern hits"
fi

echo
echo "== 3. Public IPv4 addresses ever added =="
echo "   (REVIEW AID — version strings like 3.0.4.1 and spec refs like 5.1.1.2 match too.)"
# Traced 2026-07-31, all three benign, none is the VPS: 126.0.0.0 is a netmask in
# download-surface.test.ts, 3.0.4.1 an NSIS version, 5.1.1.2 an RFC section ref in
# the auth request schema. The production IP has never been committed. Re-trace a
# NEW address with:  git log --all --oneline -S'<ip>' --name-only
ips=$(git log -p --all --no-color 2>/dev/null \
  | grep -oE '^\+.*\b((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\b' \
  | grep -oE '\b((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\b' \
  | sort -u \
  | grep -vE '^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.64\.|0\.|255\.|8\.8\.8\.8)' || true)
if [ -n "$ips" ]; then
  echo "!! review these (may be the production VPS):"
  echo "$ips"
else
  echo "ok — nothing but localhost/private/test ranges"
fi

echo
echo "== 4. .gitignore actually covers the live secret files =="
probe=(.env .env.deploy .env.mobile-signing .env.prod .env.local
       apps/api/.env apps/mobile/.env .claude/settings.local.json
       google-services.json release.jks signing.p12 AuthKey.p8
       deploy.pem id_rsa known_hosts)
ignore_gap=""
for p in "${probe[@]}"; do
  if rule=$(git check-ignore -v --no-index "$p" 2>/dev/null); then
    echo "  $rule"
  else
    echo "!! NOT IGNORED: $p"
    ignore_gap="yes"
  fi
done

echo
echo "== 5. Screenshots ever committed — MANUAL REVIEW REQUIRED =="
# HISTORY, not `git ls-files`. Deleting a screenshot from the working tree does
# not un-publish it: every blob a public repo has ever held is one `git show`
# away. This check read the index until 2026-07-31, and on the day the leaking
# `.claude/reports/` images were untracked it flipped to "ok" while all ~100 of
# them were still fully reachable — the reassuring answer arriving exactly when
# the risk had not changed at all. Only `scrub-history.sh` clears this.
shots=$(git log --all --full-history --pretty=format: --name-only \
  | sort -u \
  | grep -E '\.(png|jpg|jpeg|gif|webp)$' \
  | grep -vE '^assets/|^apps/desktop/build/|^apps/mobile/assets/|^apps/web/public/|^apps/landing/|^docs/images/' || true)
if [ -n "$shots" ]; then
  echo "$(printf '%s\n' "$shots" | wc -l) screenshot(s) reachable in history. Patterns CANNOT read these."
  echo "Either review every login / invite / profile / settings frame BY EYE, or"
  echo "remove the whole path from history (scripts/scrub-history.sh)."
  printf '%s\n' "$shots" | grep -iE 'login|signin|auth|register|invite|join|code|profile|settings|token' || echo "  (no obviously credential-bearing filenames — still spot-check)"
else
  echo "ok — no non-brand images anywhere in history"
fi

echo
echo "== 6. Refs the REMOTE serves that we never clone =="
# The blind spot that survived a full history rewrite. `refs/pull/<n>/head` is
# created by GitHub for every pull request, is NOT deleted when the PR closes,
# CANNOT be deleted by the repo owner, and is not touched by force-push. It is
# also never fetched into a normal clone, so every check above — all of which
# read local refs — is structurally incapable of seeing it.
#
# On 2026-07-31 that ref was still serving 556 pre-rewrite commits (95 internal
# report files, 548 commits carrying a personal email) hours after the local
# history had been scrubbed and every gate here was green.
#
# There is no partial fix: if an unexpected ref is listed, delete the GitHub
# repository and recreate it from the rewritten history. Support cannot remove a
# PR ref either.
remote_refs=""
if git remote get-url origin >/dev/null 2>&1; then
  remote_refs="$(git ls-remote origin 2>/dev/null |
    awk '{print $2}' |
    grep -vE '^refs/(heads|tags)/|^HEAD$' || true)"
  if [ -n "$remote_refs" ]; then
    echo "!! the remote serves refs beyond branches and tags:"
    printf '%s\n' "$remote_refs" | sed 's/^/   /'
    echo "   Fetch one to see what it holds:"
    echo "     git fetch origin <ref>  &&  git log --oneline FETCH_HEAD"
  else
    echo "ok — remote serves only branches and tags"
  fi
else
  echo "skipped — no 'origin' remote (filter-repo drops it; re-add before trusting this)"
  remote_refs=""
fi

echo
if [ -n "$paths" ] || [ -n "$ignore_gap" ]; then
  echo "RESULT: FAIL — a secret-shaped file is tracked, or .gitignore has a hole."
  echo "        See docs/security/opensource-preflight.md"
  exit 1
fi
echo "RESULT: PASS on the binary checks (steps 1 + 4)."
echo "        Steps 2, 3 and 5 are review aids — read them before going public."
# Step 5 is not a gate (it would then be red on every routine run, which is how
# step 1 got ignored). But it must not be skimmable either: a PASS line with an
# unreviewed image count under it is how the last leak survived a green sweep.
if [ -n "$shots" ]; then
  echo
  echo "        NOT CLEARED FOR PUBLIC: $(printf '%s\n' "$shots" | wc -l | tr -d ' ') image(s) in history"
  echo "        are unreadable by any pattern. Reviewed by eye, or scrubbed — pick one."
fi
if [ -n "$remote_refs" ]; then
  echo
  echo "        NOT CLEARED FOR PUBLIC: the remote serves refs this repo never clones."
  echo "        A scrubbed local history proves nothing while those exist (step 6)."
fi
