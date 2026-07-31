#!/usr/bin/env node
/**
 * Structural checks for the deploy/publish scripts and the compose files.
 *
 * These are the invariants behind the 2026-07-31 deploy hardening. Each one is
 * a rule that was BROKEN in production code, was fixed, and would be silently
 * re-broken by an ordinary-looking edit — a copy-pasted auth block, a "simpler"
 * `docker rm -f`, a port mapping written the way every tutorial writes it.
 * None of them can be caught by a type checker or by running the happy path.
 *
 * The behavioural counterpart is `scripts/test-deploy-migration.sh` (run it with
 * `pnpm test:deploy`): it drives deploy.sh against a fake Docker and asserts the
 * ORDER of the destructive steps and that the rollback restores the old stack.
 * This file is the fast half that belongs in `pnpm lint`.
 *
 * Usage:  node scripts/check-deploy-scripts.mjs
 * Exit 0 = pass, 1 = fail (with the offending rule named).
 */
/* global console, process */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(ROOT, "scripts");

const passes = [];
const failures = [];
const pass = (m) => passes.push(m);
const fail = (rule, m) => failures.push(`[${rule}] ${m}`);

const read = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), "utf8") : null);

/**
 * Drop whole-line comments so the prose that EXPLAINS a banned pattern does not
 * trip the check on it. (Every fix in this round is documented in a comment that
 * quotes the thing it removed — without this, the documentation would fail the
 * lint that the documentation exists for.)
 */
const stripComments = (body) =>
  body
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*#/.test(line));

/** The shared SSH helper — the one place a raw `-pw` fallback is allowed. */
const SSH_LIB = "scripts/lib/remote-ssh.sh";

const shellScripts = [
  ...readdirSync(SCRIPTS)
    .filter((f) => f.endsWith(".sh"))
    .map((f) => `scripts/${f}`),
  ...(existsSync(join(SCRIPTS, "lib"))
    ? readdirSync(join(SCRIPTS, "lib"))
        .filter((f) => f.endsWith(".sh"))
        .map((f) => `scripts/lib/${f}`)
    : []),
].map((name) => ({ name, body: readFileSync(join(ROOT, name), "utf8") }));

// ---------------------------------------------------------------------------
// 0. No CRLF in anything the VPS executes or parses.
//
// `scripts/deploy.sh` was committed with CRLF. On Windows nothing complains; on
// the Linux VPS the second line of the script is:
//     set: pipefail: invalid option name
// — i.e. `set -euo pipefail` FAILS and the entire deploy then runs with errexit
// and pipefail OFF, turning every guard in it into a suggestion. And
// deploy-remote.sh `git reset --hard`s the checkout on every deploy, so a CRLF
// commit reaches production immediately.
//
// .gitattributes now pins eol=lf for these paths; this check is the part that
// fails LOUDLY if a file slips through anyway (a fresh clone with a mangled
// core.autocrlf, a tool that rewrites the file in place).
// ---------------------------------------------------------------------------
{
  const targets = [
    ...shellScripts.map((s) => s.name),
    "Caddyfile",
    "docker-compose.yml",
    "docker-compose.prod.yml",
    "deploy/livekit.yaml",
  ];
  let bad = 0;
  for (const rel of targets) {
    const body = read(rel);
    if (body === null) continue;
    if (body.includes("\r")) {
      fail(
        "crlf",
        `${rel} contains CR characters. On the Linux VPS this breaks 'set -euo pipefail' ` +
          `(deploy runs with errexit OFF). Convert to LF; .gitattributes pins eol=lf.`,
      );
      bad++;
    }
  }
  if (!bad) pass("no CRLF in the deploy scripts or infra files");
}

// ---------------------------------------------------------------------------
// 1. Host keys are never waived.
//
// Every remote script REQUIRES DEPLOY_HOSTKEY, and the plink branch pins it
// properly. The sshpass branch used to pass `-o StrictHostKeyChecking=accept-new`,
// which trusts whatever answers first — so a deploy run from WSL handed the root
// password and `git reset --hard && bash scripts/deploy.sh` to the first machine
// to respond. Full VPS takeover from one bad DNS/ARP answer.
// ---------------------------------------------------------------------------
{
  const banned = /StrictHostKeyChecking\s*=\s*(accept-new|no)\b/;
  let bad = 0;
  for (const { name, body } of shellScripts) {
    for (const { line, n } of stripComments(body)) {
      if (banned.test(line)) {
        fail("hostkey", `${name}:${n} waives the host key — use the shared lib's remote_ssh_opts`);
        bad++;
      }
    }
  }
  if (!bad) pass("no script waives SSH host-key verification");
}

// ---------------------------------------------------------------------------
// 2. The password never reaches argv.
//
// `sshpass -p "$PASS"` / `plink -pw "$PASS"` put the ROOT password where any
// local process can read it (`ps`, /proc/<pid>/cmdline, Task Manager).
// deploy-remote.sh always did this right with `SSHPASS=… sshpass -e`; the
// publish scripts each grew their own copy that did not. `plink -pw` survives
// only as a documented last resort inside the library, for PuTTY < 0.77.
// ---------------------------------------------------------------------------
{
  let bad = 0;
  for (const { name, body } of shellScripts) {
    for (const { line, n } of stripComments(body)) {
      if (/\bsshpass\s+(-[^\s]*\s+)*-p\b/.test(line)) {
        fail("password-argv", `${name}:${n} uses 'sshpass -p' — use remote_password_env + 'sshpass -e'`);
        bad++;
      }
      // The lib keeps ONE `-pw` fallback for PuTTY < 0.77, which has no
      // `-pwfile`. It warns loudly and is documented in deploy.md.
      if (/\b(plink|pscp)\b[^\n]*\s-pw\s/.test(line) && name !== SSH_LIB) {
        fail("password-argv", `${name}:${n} passes -pw on the command line — use remote_putty_pw_args`);
        bad++;
      }
    }
  }
  if (!bad) pass("no script puts the SSH password in argv");
}

// ---------------------------------------------------------------------------
// 3. Anything that talks to the VPS goes through the one hardened helper.
//
// Six scripts each carried their own three-branch auth block. They drifted, and
// the drift was the hole above. A new script that hand-rolls it will drift too.
// ---------------------------------------------------------------------------
{
  const usesRemote = /\b(ssh|scp|sshpass|plink|pscp)\s/;
  let bad = 0;
  for (const { name, body } of shellScripts) {
    if (name === SSH_LIB) continue; // it IS the shared helper
    const code = stripComments(body);
    const touches = code.some(({ line }) => usesRemote.test(line));
    if (!touches) continue;
    const sources = /scripts\/lib\/remote-ssh\.sh/.test(body);
    if (!sources) {
      fail(
        "shared-ssh-lib",
        `${name} invokes ssh/scp/plink but does not source scripts/lib/remote-ssh.sh — ` +
          `it is re-implementing the auth block that had both security holes`,
      );
      bad++;
    }
  }
  if (!bad) pass("every remote script sources scripts/lib/remote-ssh.sh");
}

// ---------------------------------------------------------------------------
// 4. deploy.sh must not destroy what it cannot restore.
//
// A deploy must never destroy the running stack before the replacement has
// proven itself, and a green /health says nothing about the download tree — that
// is how a deploy once reported success while every download 404'd.
// ---------------------------------------------------------------------------
{
  const body = read("scripts/deploy.sh");
  if (body === null) {
    fail("deploy-order", "scripts/deploy.sh not found");
  } else {
    const code = stripComments(body);
    const lineNo = (re) => code.find(({ line }) => re.test(line))?.n ?? 0;

    if (code.some(({ line }) => /docker\s+rm\s+-f/.test(line))) {
      fail("deploy-order", "scripts/deploy.sh uses 'docker rm -f' — a running container must never be force-removed by a deploy");
    } else {
      pass("deploy.sh never force-removes containers");
    }

    const upAt = lineNo(/up -d --remove-orphans/);
    const edgeAt = lineNo(/Verifying the public edge/);

    if (!upAt) fail("deploy-order", "deploy.sh no longer starts the stack with 'up -d --remove-orphans'");
    else if (!edgeAt) fail("deploy-order", "deploy.sh no longer verifies the public edge after starting the stack");
    else if (!(upAt < edgeAt))
      fail("deploy-order", `order broken: up@${upAt} must come before the public-edge proof@${edgeAt}`);
    else pass("deploy.sh order: up -d -> prove the public edge");

    // Migrations must succeed before anything starts serving the new code.
    const migrateAt = lineNo(/run --rm migrate/);
    if (!migrateAt) fail("deploy-order", "deploy.sh no longer runs the one-shot database migration");
    else if (upAt && migrateAt > upAt)
      fail("deploy-order", "database migrations run AFTER the stack starts — the new code would serve against an old schema");
    else pass("deploy.sh applies migrations before starting the stack");

    if (/NOT SERVED/.test(body)) pass("deploy.sh proves the release feed is actually served");
    else fail("deploy-order", "deploy.sh no longer verifies that the release feed is served over the public edge");
  }
}

// ---------------------------------------------------------------------------
// 5. APP_ENV is pinned in the production compose file, not only in .env.prod.
//
// apps/{api,realtime}/src/env.ts activate their fail-fast secret checks ONLY
// when APP_ENV === "production". Sourced solely from the un-versioned .env.prod,
// that guard is off for any `compose up` that bypasses deploy.sh — booting the
// live stack on the devkey/devsecret this repo publishes in .env.example.
// ---------------------------------------------------------------------------
{
  const body = read("docker-compose.prod.yml");
  if (body === null) {
    fail("app-env", "docker-compose.prod.yml not found");
  } else {
    // Split into service blocks by two-space-indented keys.
    const services = {};
    let current = null;
    for (const line of body.split("\n")) {
      const m = /^ {2}([a-z0-9_-]+):\s*$/.exec(line);
      if (m) {
        current = m[1];
        services[current] = [];
      } else if (current) {
        services[current].push(line);
      }
    }
    for (const svc of ["api", "realtime", "migrate"]) {
      const block = services[svc]?.join("\n") ?? "";
      if (!block) {
        fail("app-env", `docker-compose.prod.yml has no '${svc}' service`);
      } else if (/^\s+APP_ENV:\s*(production|"production")\s*$/m.test(block)) {
        pass(`${svc} pins APP_ENV: production`);
      } else {
        fail(
          "app-env",
          `docker-compose.prod.yml '${svc}' does not pin 'APP_ENV: production'. Without it a ` +
            `compose up that skips deploy.sh boots the live stack with its secret checks disabled.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 6. The dev compose publishes nothing to 0.0.0.0.
//
// `- "5432:5432"` means every interface, and Docker's DNAT rule sits in front of
// ufw/firewalld so a host firewall does not save you. The services behind these
// ports are postgres/postgres, an unauthenticated Redis, and devkey/devsecret
// LiveKit — all three documented in a now-public repo. This file also lives in
// the production checkout, where one `docker compose up -d` without `-f` starts
// it on a box with real users.
// ---------------------------------------------------------------------------
{
  const body = read("docker-compose.yml");
  if (body === null) {
    fail("dev-ports", "docker-compose.yml not found");
  } else {
    let bad = 0;
    body.split("\n").forEach((line, i) => {
      const m = /^\s*-\s*"?([^"#]+?)"?\s*(#.*)?$/.exec(line);
      if (!m) return;
      const spec = m[1].trim();
      // A published-port mapping is "<hostpart>:<container>[/proto]"; skip
      // volume mounts (absolute paths) and command/arg lists.
      if (!/^[^\s]*:?\d+:\d+(\/(tcp|udp))?$/.test(spec)) return;
      const loopback = /^(127\.0\.0\.1|\$\{DEV_BIND_ADDR:-127\.0\.0\.1\}):/.test(spec);
      if (!loopback) {
        fail(
          "dev-ports",
          `docker-compose.yml:${i + 1} publishes '${spec}' on all interfaces — ` +
            `prefix it with \${DEV_BIND_ADDR:-127.0.0.1}:`,
        );
        bad++;
      }
    });
    if (!bad) pass("dev compose publishes every port on loopback only");
  }
}

// ---------------------------------------------------------------------------
// 7. A migration never runs without a fresh backup behind it.
//
// The production database is managed Postgres on a plan with no automatic
// backups, and deploy.sh applies generated migrations to it unattended. That is
// the one step of a deploy that re-running cannot undo: `git reset && redeploy`
// restores code, not a dropped column. The backup must therefore be taken BEFORE
// the migrate step, and a failed backup must STOP the deploy — a warning here is
// the same as no backup, because the day it warns is the day it matters.
//
// The counterpart is behavioural: scripts/test-deploy-migration.sh scenario 6
// makes the backup fail against a fake Docker and asserts that `run --rm migrate`
// never appears in the command log.
// ---------------------------------------------------------------------------
{
  const body = read("scripts/deploy.sh");
  const backup = read("scripts/backup-db.sh");

  if (backup === null) {
    fail("db-backup", "scripts/backup-db.sh is missing — the deploy has no pre-migration backup");
  } else if (body === null) {
    fail("db-backup", "scripts/deploy.sh not found");
  } else {
    const code = stripComments(body);
    const backupLine = code.find(({ line }) => /backup-db\.sh/.test(line));
    const migrateLine = code.find(({ line }) => /run --rm migrate/.test(line));

    if (!backupLine) {
      fail("db-backup", "scripts/deploy.sh no longer takes a pre-migration backup (scripts/backup-db.sh)");
    } else if (!migrateLine) {
      fail("db-backup", "scripts/deploy.sh no longer runs the one-shot migration");
    } else if (backupLine.n > migrateLine.n) {
      fail(
        "db-backup",
        `order broken: the backup@${backupLine.n} runs AFTER the migration@${migrateLine.n} — ` +
          `the snapshot would already contain the change it exists to undo`,
      );
    } else {
      pass("deploy.sh backs the database up before migrating");

      // ...and the failure of that backup must abort, not warn.
      const window = code.filter(({ n }) => n >= backupLine.n && n <= backupLine.n + 8);
      if (window.some(({ line }) => /\bfail\b/.test(line))) {
        pass("a failed pre-migration backup aborts the deploy");
      } else {
        fail(
          "db-backup",
          `scripts/deploy.sh:${backupLine.n} does not abort when the backup fails — ` +
            `an unbacked migration must never proceed`,
        );
      }
    }
  }

  // The connection string carries the database password. It must never reach an
  // argument vector (`ps`, /proc/<pid>/cmdline) — including inside a container,
  // whose processes are listed by the host too. Same rule as rule 2 for SSH.
  {
    let bad = 0;
    for (const { name, body: sh } of shellScripts) {
      for (const { line, n } of stripComments(sh)) {
        if (/\b(psql|pg_dump|pg_restore|pg_dumpall)\b[^\n]*\$\{?DATABASE_URL/.test(line)) {
          fail(
            "db-backup",
            `${name}:${n} passes DATABASE_URL on a command line — the password becomes ` +
              `world-readable in the process list. Use the libpq env vars ` +
              `(pgb_export_libpq_env in scripts/lib/pg-backup.sh).`,
          );
          bad++;
        }
      }
    }
    if (!bad) pass("no script puts the database URL in argv");
  }

  // Backups must not land in a directory Caddy serves. /srv/demli-dl is bind-
  // mounted into the proxy and published at https://api.<DOMAIN>/dl/ — a dump
  // written there would be a public download of every user's data.
  if (backup !== null) {
    const m = /BACKUP_DIR:-([^}"']+)/.exec(backup);
    const dir = m?.[1]?.trim();
    const compose = read("docker-compose.prod.yml") ?? "";
    const servedRoots = [...compose.matchAll(/^\s*-\s*(\/srv\/[A-Za-z0-9._-]+):/gm)].map((x) => x[1]);
    if (!dir) {
      fail("db-backup", "scripts/backup-db.sh has no BACKUP_DIR default to check");
    } else if (servedRoots.some((root) => dir === root || dir.startsWith(`${root}/`))) {
      fail(
        "db-backup",
        `the default backup directory ${dir} is inside a host tree bind-mounted into the ` +
          `stack (${servedRoots.join(", ")}) — dumps would be publicly downloadable`,
      );
    } else {
      pass(`backups default to ${dir}, outside every mounted/served host tree`);
    }
  }
}

for (const p of passes) console.log(`  ok   ${p}`);
for (const f of failures) console.error(`  FAIL ${f}`);
if (failures.length) {
  console.error(`\n${failures.length} deploy-hardening check(s) failed.`);
  process.exit(1);
}
console.log("\nAll deploy/compose hardening invariants hold.");
