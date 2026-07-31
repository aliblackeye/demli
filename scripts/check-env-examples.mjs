#!/usr/bin/env node
/**
 * An `.env.example` is a promise: copy me to `.env` and the app will read it.
 *
 * `apps/api` and `apps/realtime` shipped that file and broke that promise for
 * months. Their dev scripts were a bare `tsx watch src/index.ts` — no dotenv, no
 * `--env-file` — so every value came from the zod defaults in `env.ts` and an
 * edited `.env` did precisely nothing. Nothing failed: the server booted happily
 * on `devkey`/`devsecret`, which is the worst shape a configuration bug can take,
 * and worse still for a self-hoster reading the README of a public repo.
 *
 * Found 2026-07-31 by an agent that had to pass CORS_ORIGIN as a real environment
 * variable after editing `.env` changed nothing. No test could have caught it,
 * because both halves — the example file and the start command — were
 * individually fine. The defect lived in the space between them, which is what
 * this check occupies.
 *
 * Run from the root `lint` script.
 */
/* global console, process */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPS = join(ROOT, "apps");

/** Ways a package can legitimately end up with its `.env` loaded. */
const LOADS_ENV = [
  /--env-file(-if-exists)?=/, // node / tsx flag
  /dotenv/, // dotenv-cli, `-r dotenv/config`, an import
];

/**
 * Packages that ship an example but are NOT started by a package script, so
 * there is nothing here to assert. Each entry needs a reason, not just a name.
 */
const EXEMPT = new Map([
  ["desktop", "Vite reads .env itself (VITE_* at build time); no server script."],
  ["web", "Vite reads .env itself; no server script."],
  ["mobile", "Expo reads .env itself; the app is built, not started by a script."],
  ["landing", "Vite reads .env itself; the dev server is plain `vite`."],
]);

const failures = [];

for (const app of readdirSync(APPS, { withFileTypes: true })) {
  if (!app.isDirectory()) continue;
  const dir = join(APPS, app.name);
  if (!existsSync(join(dir, ".env.example"))) continue;
  if (EXEMPT.has(app.name)) continue;

  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) continue;
  const scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {};

  for (const name of ["dev", "start"]) {
    const cmd = scripts[name];
    if (!cmd) continue;
    if (LOADS_ENV.some((re) => re.test(cmd))) continue;
    failures.push(
      `apps/${app.name}: ships .env.example but its "${name}" script never loads a .env\n` +
        `    ${name}: ${cmd}\n` +
        `    Fix: add --env-file-if-exists=.env, or delete the example if the app truly ` +
        `takes config only from the real environment.`,
    );
  }
}

if (failures.length > 0) {
  console.error("An .env.example is lying about being read:\n");
  for (const f of failures) console.error("  " + f + "\n");
  process.exit(1);
}

console.log("Every .env.example is actually loaded by its app's dev/start script.");
