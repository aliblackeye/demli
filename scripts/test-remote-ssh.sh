#!/usr/bin/env bash
# Behavioural test for the host-key pinning in scripts/lib/remote-ssh.sh.
#
# The audited hole was that the sshpass branch used
# `-o StrictHostKeyChecking=accept-new`, i.e. it trusted whatever answered and
# then sent it the root password. `scripts/check-deploy-scripts.mjs` can only
# prove that string is gone; it cannot prove the replacement WORKS. So this
# generates two real ed25519 keys, stubs ssh-keyscan to present one or the
# other, and checks that the pinned fingerprint accepts exactly one of them.
#
# A test that only ever presents the RIGHT key would pass against a lib that
# accepts everything — which is the bug. The impostor case is the point.
#
# Run:  bash scripts/test-remote-ssh.sh   (or `pnpm test:deploy`)
set -uo pipefail

LIB="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/remote-ssh.sh}"
[ -f "$LIB" ] || { echo "MISSING: $LIB" >&2; exit 1; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ssh-keygen -q -t ed25519 -N '' -C good -f "$WORK/good" </dev/null
ssh-keygen -q -t ed25519 -N '' -C evil -f "$WORK/evil" </dev/null

GOOD_FP="$(ssh-keygen -lf "$WORK/good.pub" | awk '{print $2}')"
EVIL_FP="$(ssh-keygen -lf "$WORK/evil.pub" | awk '{print $2}')"
GOOD_MD5="$(ssh-keygen -E md5 -lf "$WORK/good.pub" | awk '{print $2}')"

# Fake ssh-keyscan: prints whichever key SCAN_KEY points at, in keyscan format.
mkdir -p "$WORK/bin"
cat >"$WORK/bin/ssh-keyscan" <<'EOS'
#!/usr/bin/env bash
host="${@: -1}"
printf '%s %s\n' "$host" "$(cut -d' ' -f1,2 < "$SCAN_KEY")"
EOS
chmod +x "$WORK/bin/ssh-keyscan"
PATH="$WORK/bin:$PATH"
export PATH

pass=0
fail=0
check() { # name expected_status actual_status extra
	if [ "$2" = "$3" ]; then
		echo "  ok   $1"
		pass=$((pass + 1))
	else
		echo "  FAIL $1 (expected status $2, got $3) $4"
		fail=$((fail + 1))
	fi
}

run_case() { # DEPLOY_HOSTKEY, SCAN_KEY -> prints known_hosts path, status in $?
	env -u _REMOTE_SSH_SH_LOADED \
		SCAN_KEY="$2" DEPLOY_HOST="root@10.0.0.1" DEPLOY_HOSTKEY="$1" \
		bash -c '
			set -euo pipefail
			. "$0"
			remote_ssh_opts
			for o in "${REMOTE_SSH_OPTS[@]}"; do printf "%s\n" "$o"; done
		' "$LIB" 2>"$WORK/err"
}

echo "== host-key pinning =="

out="$(run_case "$GOOD_FP" "$WORK/good.pub")"; st=$?
check "matching SHA256 fingerprint is accepted" 0 "$st" "$(cat "$WORK/err")"
case "$out" in
*"StrictHostKeyChecking=yes"*) echo "  ok   uses StrictHostKeyChecking=yes"; pass=$((pass + 1)) ;;
*) echo "  FAIL StrictHostKeyChecking=yes missing"; fail=$((fail + 1)) ;;
esac
case "$out" in
*"accept-new"*) echo "  FAIL accept-new leaked into the options"; fail=$((fail + 1)) ;;
*) echo "  ok   no accept-new anywhere"; pass=$((pass + 1)) ;;
esac
kh="$(printf '%s\n' "$out" | sed -n 's/^UserKnownHostsFile=//p')"

out="$(run_case "ssh-ed25519 255 $GOOD_FP" "$WORK/good.pub")"; st=$?
check "PuTTY-style 'ssh-ed25519 255 SHA256:…' pin is accepted" 0 "$st" "$(cat "$WORK/err")"

out="$(run_case "$GOOD_MD5" "$WORK/good.pub")"; st=$?
check "MD5 pin (old PuTTY) is accepted" 0 "$st" "$(cat "$WORK/err")"

out="$(run_case "${GOOD_MD5#MD5:}" "$WORK/good.pub")"; st=$?
check "bare colon-hex MD5 pin is accepted" 0 "$st" "$(cat "$WORK/err")"

out="$(run_case "$GOOD_FP" "$WORK/evil.pub")"; st=$?
check "IMPOSTOR host key is refused" 1 "$st" ""
grep -q "HOST KEY MISMATCH" "$WORK/err" &&
	{ echo "  ok   mismatch is reported loudly"; pass=$((pass + 1)); } ||
	{ echo "  FAIL mismatch message missing"; fail=$((fail + 1)); }

out="$(run_case "$EVIL_FP" "$WORK/good.pub")"; st=$?
check "wrong pin refuses the real host too" 1 "$st" ""

out="$(run_case "not-a-fingerprint" "$WORK/good.pub")"; st=$?
check "garbage DEPLOY_HOSTKEY is rejected, not ignored" 1 "$st" ""

out="$(env -u DEPLOY_HOSTKEY -u _REMOTE_SSH_SH_LOADED \
	SCAN_KEY="$WORK/good.pub" DEPLOY_HOST="root@10.0.0.1" \
	bash -c 'set -euo pipefail; . "$0"; remote_ssh_opts' "$LIB" 2>"$WORK/err")"; st=$?
check "missing DEPLOY_HOSTKEY fails closed" 1 "$st" ""

# DEPLOY_KNOWN_HOSTS escape hatch
printf 'x\n' >"$WORK/kh"
out="$(env -u _REMOTE_SSH_SH_LOADED \
	DEPLOY_KNOWN_HOSTS="$WORK/kh" DEPLOY_HOST="root@10.0.0.1" DEPLOY_HOSTKEY="ignored" \
	bash -c 'set -euo pipefail; . "$0"; remote_ssh_opts; printf "%s\n" "${REMOTE_SSH_OPTS[@]}"' "$LIB" 2>"$WORK/err")"; st=$?
check "DEPLOY_KNOWN_HOSTS bypasses the keyscan" 0 "$st" "$(cat "$WORK/err")"

echo ""
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
