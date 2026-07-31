/**
 * Skip-proofing for the integration suites.
 *
 * Every integration file in this repo probes its service first and hands the
 * result to `describe.skipIf(!dbUp)`, so a suite whose Postgres or Redis is
 * missing does not fail a laptop run. That is the right default locally, and it
 * is a lie in CI: if the Postgres service container ever fails to come up — a
 * port change, a broken health check, a migration step reordered ahead of the
 * wait — then ~90 integration suites skip and `pnpm test` still exits 0. The
 * gate stays green after it has stopped looking at anything, which is the exact
 * failure class this repo has already shipped six times.
 *
 * CI therefore sets `DEMLI_TEST_REQUIRE_DB=1`, which turns "skip quietly" into
 * "fail loudly at collection time". Local behaviour is unchanged when the
 * variable is absent: the existing `console.warn` + skip still happens.
 *
 * The guard itself is verified the only way a gate can be: by breaking it. Point
 * `DATABASE_URL` at a dead port with the flag set and the run must go red. Do
 * not trust it because it is written down.
 */

/** The services an integration suite can refuse to skip without. */
export type RequiredService = "postgres" | "redis";

const ENV_FLAG = "DEMLI_TEST_REQUIRE_DB";

const URL_VAR: Record<RequiredService, string> = {
  postgres: "DATABASE_URL",
  redis: "REDIS_URL",
};

/**
 * Connection strings carry passwords. The failure message has to name the URL
 * that was tried — "unreachable" without a target is useless — but a CI log is
 * a public artifact on a public repo, so the credentials come out first.
 */
function redact(url: string | undefined): string {
  if (!url) return "<unset — the suite's localhost default was used>";
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "<unparseable>";
  }
}

/**
 * Call this from the `if (!dbUp)` / `if (!redisUp)` branch of an integration
 * suite, BEFORE the `console.warn` that announces the skip.
 *
 * No-op unless `DEMLI_TEST_REQUIRE_DB` is set to something truthy; throws
 * otherwise, which fails the file at collection time and takes the whole run
 * with it.
 */
export function refuseToSkipIfRequired(service: RequiredService): void {
  const flag = process.env[ENV_FLAG];
  if (!flag || flag === "0" || flag === "false") return;

  const urlVar = URL_VAR[service];
  throw new Error(
    `${ENV_FLAG}=${flag} is set but ${service} is unreachable ` +
      `(${urlVar}=${redact(process.env[urlVar])}). Refusing to skip this suite — ` +
      `a skipped integration suite reports success without testing anything. ` +
      `Start the services with \`pnpm db:up\`, or unset ${ENV_FLAG} to allow skipping.`,
  );
}
