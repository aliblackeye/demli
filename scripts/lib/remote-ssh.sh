#!/usr/bin/env bash
# Shared SSH hardening for every script that talks to the VPS.
#
# WHY THIS FILE EXISTS
# --------------------
# Five scripts (deploy-remote, publish-desktop, publish-web, publish-landing,
# publish-mobile-apk, add-assetlinks-package) each grew their own copy of the
# same three-branch auth block: PuTTY plink/pscp -> sshpass -> ssh key. The
# copies drifted, and the drift was a security hole in both directions:
#
#   1. HOST KEY IGNORED (security-review, HIGH). Every script REQUIRES
#      DEPLOY_HOSTKEY and passes it to plink -hostkey, which genuinely pins the
#      server identity. The sshpass branch then threw it away and used
#      `-o StrictHostKeyChecking=accept-new`, which trusts whatever answers on
#      the FIRST connection. A deploy run from WSL (no plink) therefore handed
#      the root password AND `git reset --hard && bash scripts/deploy.sh` to the
#      first machine that answered. That is a full VPS takeover from one DNS or
#      ARP answer, with no warning printed anywhere.
#
#   2. PASSWORD ON THE COMMAND LINE (security-review, HIGH). `sshpass -p "$PASS"`
#      and `plink -pw "$PASS"` put the root password in argv, where any local
#      process can read it out of `ps` / /proc/<pid>/cmdline / Task Manager.
#      deploy-remote.sh already did this correctly with `SSHPASS=… sshpass -e`;
#      the publish scripts never followed.
#
# WHAT THIS FILE DOES ABOUT IT
# ----------------------------
# `remote_ssh_opts` builds a temporary known_hosts containing ONLY keys whose
# fingerprint equals the pinned DEPLOY_HOSTKEY, then hands back
# `StrictHostKeyChecking=yes` pointing at it. That is exactly plink's `-hostkey`
# semantics expressed in OpenSSH terms: the key is fetched from the host, but it
# is ACCEPTED only if it matches the value the founder pinned out of band. A
# man-in-the-middle presents a different key, the fingerprint does not match, and
# the connection is refused before any credential is sent.
#
# `remote_password_env` / `remote_putty_pw_args` keep the password off argv:
# OpenSSH via `SSHPASS=… sshpass -e`, PuTTY via `-pwfile` (0.77+) with a
# 0600 temp file, falling back to `-pw` on older PuTTY with a loud warning.
#
# USAGE
#   SCRIPT_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   . "$REPO_ROOT/scripts/lib/remote-ssh.sh"
#   remote_ssh_opts            # -> REMOTE_SSH_OPTS array  (ssh/scp/sshpass)
#   remote_putty_pw_args       # -> REMOTE_PUTTY_ARGS array (plink/pscp)
#
# Both are idempotent: the keyscan runs once per process, the temp files are
# created once and removed by an EXIT trap.
#
# ESCAPE HATCH: set DEPLOY_KNOWN_HOSTS=/path/to/known_hosts to supply a
# known_hosts file directly (e.g. an ed25519 deploy key managed elsewhere); the
# keyscan is then skipped entirely and the file is used as-is.

# Guard against double-sourcing (publish scripts may source it more than once).
if [ -n "${_REMOTE_SSH_SH_LOADED:-}" ]; then
	return 0 2>/dev/null || true
fi
_REMOTE_SSH_SH_LOADED=1

REMOTE_SSH_OPTS=()
REMOTE_SCP_OPTS=()
REMOTE_PUTTY_ARGS=()
_REMOTE_TMPDIR=""
_REMOTE_KNOWN_HOSTS=""
# Plain flags rather than `${#ARR[@]}` tests: expanding an empty array under
# `set -u` is an error on bash 4.3 and older, which some Git Bash installs still
# ship.
_REMOTE_SSH_OPTS_READY=0
_REMOTE_PUTTY_ARGS_READY=0

_remote_fail() {
	printf '\n\033[1;31m[remote-ssh] ERROR:\033[0m %s\n' "$*" >&2
	exit 1
}

_remote_warn() {
	printf '\033[1;33m[remote-ssh] WARN:\033[0m %s\n' "$*" >&2
}

# One 0700 temp dir for the known_hosts and the PuTTY password file, wiped on
# exit. Anything holding a credential lives here and nowhere else.
#
# Sets the GLOBAL `_REMOTE_TMPDIR` rather than echoing the path: called as
# `dir="$(_remote_tmpdir)"` it would run in a subshell, whose EXIT trap fires the
# instant the substitution ends and deletes the directory the caller just asked
# for. (Cost one debugging round on 2026-07-31 — do not "simplify" it back.)
#
# NOTE: this installs an EXIT trap. Sourcing scripts must not set their own EXIT
# trap after calling into this library, or the temp dir leaks the password file.
_remote_ensure_tmpdir() {
	[ -n "${_REMOTE_TMPDIR}" ] && return 0
	_REMOTE_TMPDIR="$(mktemp -d 2>/dev/null || mktemp -d -t demli-remote)"
	[ -n "${_REMOTE_TMPDIR}" ] || _remote_fail "could not create a temp dir for the host-key/password files"
	chmod 700 "${_REMOTE_TMPDIR}" 2>/dev/null || true
	# shellcheck disable=SC2064  # expand the path NOW, not at trap time
	trap "rm -rf '${_REMOTE_TMPDIR}'" EXIT
}

# The bare hostname/IP out of DEPLOY_HOST ("root@1.2.3.4" -> "1.2.3.4").
remote_host_only() {
	printf '%s' "${DEPLOY_HOST##*@}"
}

remote_port() {
	printf '%s' "${DEPLOY_PORT:-22}"
}

# Reduce a pinned fingerprint to the token ssh-keygen prints, so the PuTTY forms
# all normalise to the same thing:
#   "ssh-ed25519 255 SHA256:abc…"      (PuTTY 0.78 -hostkey line)
#   "SHA256:abc…"                       (ssh-keygen -lf)
#   "aa:bb:cc:…"                        (old PuTTY / MD5 hex)
#   "MD5:aa:bb:…"
# Returns the comparable token; empty if the input is not a fingerprint at all.
_remote_normalize_fingerprint() {
	local raw="$1" tok
	for tok in ${raw}; do
		case "${tok}" in
		SHA256:*) printf '%s' "${tok}"; return 0 ;;
		MD5:*) printf '%s' "${tok}"; return 0 ;;
		esac
	done
	# Bare colon-hex (16 MD5 bytes) — old PuTTY prints it without the "MD5:" tag.
	case "${raw}" in
	*:*:*:*:*:*:*:*:*:*:*:*:*:*:*:*)
		if printf '%s' "${raw}" | grep -qiE '^[0-9a-f]{2}(:[0-9a-f]{2}){15}$'; then
			printf 'MD5:%s' "$(printf '%s' "${raw}" | tr 'A-F' 'a-f')"
			return 0
		fi
		;;
	esac
	printf ''
}

# Build (once) a known_hosts holding only host keys whose fingerprint matches the
# pinned DEPLOY_HOSTKEY, and export the ssh options that use it.
#
# This is the whole point of the file: `accept-new` trusts the first answer,
# this trusts only the pinned answer.
remote_ssh_opts() {
	[ "${_REMOTE_SSH_OPTS_READY}" = "1" ] && return 0

	: "${DEPLOY_HOST:?Set DEPLOY_HOST=user@host (the VPS SSH target), or put it in .env.deploy}"

	if [ -n "${DEPLOY_KNOWN_HOSTS:-}" ]; then
		[ -f "${DEPLOY_KNOWN_HOSTS}" ] ||
			_remote_fail "DEPLOY_KNOWN_HOSTS=${DEPLOY_KNOWN_HOSTS} does not exist"
		_REMOTE_KNOWN_HOSTS="${DEPLOY_KNOWN_HOSTS}"
	else
		# Sets _REMOTE_KNOWN_HOSTS. Called plainly, NOT as `$(...)`: a subshell
		# would take its temp dir (and any _remote_fail exit) with it.
		_remote_build_known_hosts
	fi

	REMOTE_SSH_OPTS=(
		-o "UserKnownHostsFile=${_REMOTE_KNOWN_HOSTS}"
		-o "GlobalKnownHostsFile=/dev/null"
		-o "StrictHostKeyChecking=yes"
		-o "HashKnownHosts=no"
		-o "NumberOfPasswordPrompts=1"
		-o "ConnectTimeout=15"
	)
	if [ "$(remote_port)" != "22" ]; then
		REMOTE_SSH_OPTS+=(-p "$(remote_port)")
	fi
	_REMOTE_SSH_OPTS_READY=1
}

# scp takes the port as -P, not -p. Same options otherwise.
remote_scp_opts() {
	remote_ssh_opts
	REMOTE_SCP_OPTS=()
	local o
	for o in "${REMOTE_SSH_OPTS[@]}"; do
		if [ "${o}" = "-p" ]; then
			REMOTE_SCP_OPTS+=(-P)
		else
			REMOTE_SCP_OPTS+=("${o}")
		fi
	done
}

_remote_build_known_hosts() {
	: "${DEPLOY_HOSTKEY:?Set DEPLOY_HOSTKEY (the VPS SSH host-key fingerprint) in .env.deploy}"

	command -v ssh-keyscan >/dev/null 2>&1 ||
		_remote_fail "ssh-keyscan not found, so the pinned DEPLOY_HOSTKEY cannot be verified.
  Install openssh-client, or point DEPLOY_KNOWN_HOSTS at a known_hosts file.
  (There is deliberately no fallback to unverified host keys — accepting the
  first key offered would hand the root password to whatever answers.)"
	command -v ssh-keygen >/dev/null 2>&1 ||
		_remote_fail "ssh-keygen not found, so host-key fingerprints cannot be computed."

	local pinned host port scanned verified line fp
	pinned="$(_remote_normalize_fingerprint "${DEPLOY_HOSTKEY}")"
	[ -n "${pinned}" ] || _remote_fail "DEPLOY_HOSTKEY='${DEPLOY_HOSTKEY}' is not a recognisable
  fingerprint. Expected a SHA256:… (or MD5 colon-hex) form, e.g. what
    ssh-keyscan -t ed25519 <host> | ssh-keygen -lf -
  prints, or the -hostkey line PuTTY shows on first connect."

	host="$(remote_host_only)"
	port="$(remote_port)"
	_remote_ensure_tmpdir
	scanned="${_REMOTE_TMPDIR}/scanned"
	verified="${_REMOTE_TMPDIR}/known_hosts"

	: >"${verified}"
	chmod 600 "${verified}" 2>/dev/null || true

	if ! ssh-keyscan -T 15 -p "${port}" "${host}" >"${scanned}" 2>/dev/null; then
		_remote_fail "ssh-keyscan could not reach ${host}:${port} — is the VPS up and 22 open?"
	fi
	[ -s "${scanned}" ] || _remote_fail "ssh-keyscan returned no host keys for ${host}:${port}."

	# Keep only the keys whose fingerprint equals the pinned one. An impostor's
	# key lands in `scanned` too — and is dropped right here, before ssh ever
	# opens a session and before sshpass ever types the password.
	while IFS= read -r line; do
		case "${line}" in
		"" | \#*) continue ;;
		esac
		fp="$(printf '%s\n' "${line}" | ssh-keygen -lf - 2>/dev/null | awk '{print $2}')"
		[ -n "${fp}" ] || continue
		if [ "${fp}" = "${pinned}" ]; then
			printf '%s\n' "${line}" >>"${verified}"
			continue
		fi
		# MD5 pins need a second pass: ssh-keygen defaults to SHA256.
		case "${pinned}" in
		MD5:*)
			fp="$(printf '%s\n' "${line}" | ssh-keygen -E md5 -lf - 2>/dev/null | awk '{print $2}')"
			if [ "${fp}" = "${pinned}" ]; then
				printf '%s\n' "${line}" >>"${verified}"
			fi
			;;
		esac
	done <"${scanned}"

	if [ ! -s "${verified}" ]; then
		local seen
		seen="$(ssh-keygen -lf "${scanned}" 2>/dev/null | awk '{print "    " $2 "  " $4}' | sort -u)"
		_remote_fail "HOST KEY MISMATCH for ${host}:${port}.

  Pinned  (DEPLOY_HOSTKEY): ${pinned}
  Offered by the host:
${seen:-    (could not fingerprint the scanned keys)}

  Nothing was sent. Either the VPS was rebuilt/re-keyed (update DEPLOY_HOSTKEY
  in .env.deploy after checking the new key on the provider console), or you are
  not talking to the VPS. Do NOT work around this by disabling the check."
	fi

	_REMOTE_KNOWN_HOSTS="${verified}"
}

# PuTTY (plink/pscp) argument array: -batch, the pinned -hostkey, and the
# password supplied WITHOUT putting it in argv when this PuTTY supports it.
#
# `-pwfile` landed in PuTTY 0.77 precisely because `-pw` leaks to `ps`. Older
# builds have no alternative at all, so we keep working and say so out loud —
# the permanent fix is an ed25519 deploy key (docs/architecture/deploy.md).
remote_putty_pw_args() {
	[ "${_REMOTE_PUTTY_ARGS_READY}" = "1" ] && return 0
	: "${DEPLOY_HOSTKEY:?Set DEPLOY_HOSTKEY (the VPS SSH host-key fingerprint) in .env.deploy}"

	REMOTE_PUTTY_ARGS=(-batch -hostkey "${DEPLOY_HOSTKEY}")
	if [ "$(remote_port)" != "22" ]; then
		REMOTE_PUTTY_ARGS+=(-P "$(remote_port)")
	fi
	_REMOTE_PUTTY_ARGS_READY=1
	[ -n "${DEPLOY_PASS:-}" ] || return 0

	# Capture the usage text instead of piping into grep: plink exits non-zero
	# when invoked with no arguments, and under `set -o pipefail` that would make
	# the whole probe look like "no -pwfile support" regardless of what it printed.
	local tool="${1:-plink}" pwfile usage
	usage=""
	if command -v "${tool}" >/dev/null 2>&1; then
		usage="$("${tool}" 2>&1 || true)"
	fi
	if [ -n "${usage}" ] && printf '%s' "${usage}" | grep -q -- '-pwfile'; then
		_remote_ensure_tmpdir
		pwfile="${_REMOTE_TMPDIR}/putty-pw"
		# Create empty with 0600 BEFORE writing, so the secret is never briefly
		# world-readable.
		: >"${pwfile}"
		chmod 600 "${pwfile}" 2>/dev/null || true
		printf '%s\n' "${DEPLOY_PASS}" >"${pwfile}"
		REMOTE_PUTTY_ARGS+=(-pwfile "${pwfile}")
	else
		_remote_warn "this PuTTY has no -pwfile, so the password goes on the command line
  (readable via Task Manager / ps). Upgrade PuTTY to 0.77+, or switch to an
  ed25519 deploy key — see docs/architecture/deploy.md, 'SSH credentials'."
		REMOTE_PUTTY_ARGS+=(-pw "${DEPLOY_PASS}")
	fi
}

# Export SSHPASS for `sshpass -e`. NEVER use `sshpass -p "$PASS"`: argv is
# world-readable on every OS this runs on.
remote_password_env() {
	[ -n "${DEPLOY_PASS:-}" ] || return 0
	SSHPASS="${DEPLOY_PASS}"
	export SSHPASS
}
