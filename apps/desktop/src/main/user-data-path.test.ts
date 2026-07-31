import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEV_USER_DATA_DIR,
  PACKAGED_USER_DATA_SEGMENTS,
  resolveUserDataPath,
} from "./user-data-path";

/**
 * DATA-LOSS REGRESSION GUARD.
 *
 * The packaged app's userData directory holds the multi-account vault, the
 * session token, desktop settings and Chromium's whole profile. Electron would
 * normally derive that directory from `app.getName()` — i.e. from `productName`
 * / the npm package name / electron-builder's `extraMetadata` — so any of those
 * moving would relocate it and sign everyone out with no error and no way back.
 *
 * These tests pin the path and prove the main process applies it before anything
 * else reads userData.
 */

const APP_DATA = join("C:", "Users", "someone", "AppData", "Roaming");

describe("resolveUserDataPath", () => {
  it("resolves a packaged install to the pinned directory", () => {
    expect(resolveUserDataPath(APP_DATA, true)).toBe(join(APP_DATA, "Demli"));
  });

  it("gives unpackaged (dev) runs a separate profile", () => {
    const dev = resolveUserDataPath(APP_DATA, false);
    expect(dev).toBe(join(APP_DATA, DEV_USER_DATA_DIR));
    expect(dev).not.toBe(resolveUserDataPath(APP_DATA, true));
  });

  it("is a pure function of its inputs — no reliance on app.getName()", () => {
    const other = join("/home", "someone", ".config");
    expect(resolveUserDataPath(other, true)).toBe(
      join(other, ...PACKAGED_USER_DATA_SEGMENTS),
    );
    // Same inputs, same answer, every time (no hidden state to drift).
    expect(resolveUserDataPath(other, true)).toBe(resolveUserDataPath(other, true));
  });

  it("is actually applied by the main process before anything reads userData", () => {
    // A correct helper that nobody calls would be worthless, and the ORDER
    // matters: the crash reporter, the single-instance lock and the secure
    // stores all resolve userData at module load. Assert the call sits ahead of
    // them in main/index.ts.
    const source = mainSource();

    const setPathAt = source.indexOf('app.setPath(\n  "userData"');
    expect(setPathAt).toBeGreaterThan(-1);
    expect(source).toContain('resolveUserDataPath(app.getPath("appData"), app.isPackaged)');

    for (const laterCall of ["startCrashReporter()", "app.requestSingleInstanceLock()"]) {
      const at = source.indexOf(laterCall);
      expect(at, `${laterCall} not found in main/index.ts`).toBeGreaterThan(-1);
      expect(at, `${laterCall} must run AFTER the userData pin`).toBeGreaterThan(setPathAt);
    }
  });
});

function mainSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, "index.ts"), "utf8");
}
