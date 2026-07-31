import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The desktop identity is spread over three files that MUST agree, and every
 * disagreement fails silently in production rather than at build time:
 *
 *   - electron-builder.yml `appId` vs. main/notifications.ts
 *     `WINDOWS_APP_USER_MODEL_ID` — mismatch and Windows attributes every toast
 *     to "electron.exe" instead of Demli (and on some builds drops it entirely).
 *   - electron-builder.yml `publish.channel` vs. main/auto-update.ts
 *     `UPDATE_CHANNEL` — mismatch and the app polls a manifest nobody publishes
 *     to, i.e. it never auto-updates again, with no error anywhere.
 *
 * Neither is checked by TypeScript (one side is YAML), so it is checked here.
 *
 * `auto-update.ts` is read as TEXT rather than imported: it pulls in `electron`
 * and `electron-updater` at module load, neither of which exists in the vitest
 * node environment. Same approach as auto-update-schedule.test.ts.
 */

const here = dirname(fileURLToPath(import.meta.url));

function builderConfig(): string {
  return readFileSync(resolve(here, "../../electron-builder.yml"), "utf8");
}

/** `UPDATE_CHANNEL` as declared in main/auto-update.ts. */
function updateChannel(): string {
  const source = readFileSync(resolve(here, "auto-update.ts"), "utf8");
  const value = /UPDATE_CHANNEL(?::\s*\w+)?\s*=\s*"([^"]+)"/.exec(source)?.[1];
  expect(value, "UPDATE_CHANNEL not found in main/auto-update.ts").toBeDefined();
  return value as string;
}

function readScalar(source: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}:\\s*([^\\s#]+)`, "m").exec(source);
  return match?.[1] ?? null;
}

describe("desktop app identity", () => {
  it("ships the pinned appId", () => {
    const appId = readScalar(builderConfig(), "appId");
    expect(appId).toBe("app.demli.desktop");
  });

  it("uses the appId as the Windows AppUserModelID", () => {
    const appId = readScalar(builderConfig(), "appId");
    const notifications = readFileSync(resolve(here, "notifications.ts"), "utf8");
    const modelId = /WINDOWS_APP_USER_MODEL_ID\s*=\s*"([^"]+)"/.exec(notifications)?.[1];
    expect(modelId, "WINDOWS_APP_USER_MODEL_ID not found").toBeDefined();
    expect(modelId).toBe(appId);
  });

  it("keeps the update channel in main in sync with the publish config", () => {
    const channel = readScalar(builderConfig(), "channel");
    expect(channel).toBe(updateChannel());
    // `latest` is electron-updater's default, i.e. what a lost channel silently
    // falls back to — and nothing publishes it, so such a build never updates.
    expect(updateChannel()).not.toBe("latest");
  });

  it("passes the channel through when the feed URL is overridden by env", () => {
    // electron-updater's generic provider defaults to `latest` when no channel
    // is given, so a `setFeedURL` without one silently points an env-configured
    // build at a manifest nobody publishes.
    const source = readFileSync(resolve(here, "auto-update.ts"), "utf8");
    expect(source).toMatch(/setFeedURL\(\{[^}]*channel:\s*UPDATE_CHANNEL/);
  });

  it("scopes the forced-update side-car to the channel", () => {
    // `critical.json` (unprefixed) is not this channel's file. A build obeying it
    // would take a forced-update floor aimed at a different version line.
    const source = readFileSync(resolve(here, "auto-update.ts"), "utf8");
    expect(source).toMatch(/\$\{UPDATE_CHANNEL\}-critical\.json/);
    expect(source).toMatch(/\$\{feedBase\(\)\}\$\{criticalFileName\(\)\}/);
  });

  it("pins the install directory independently of the workspace package name", () => {
    // For oneClick + per-user installs electron-builder derives the install
    // folder from the sanitized package `name`, NOT productName. Without this
    // override the install directory would follow the workspace package name
    // (`@demli/desktop` → %LocalAppData%\Programs\@demlidesktop), so a workspace
    // rename would move where the app installs.
    const config = builderConfig();
    expect(config).toMatch(/^extraMetadata:/m);
    const overriddenName = /^extraMetadata:\s*\n\s+name:\s*([^\s#]+)/m.exec(config)?.[1];
    expect(overriddenName, "extraMetadata.name not found").toBeDefined();

    const pkg = JSON.parse(readFileSync(resolve(here, "../../package.json"), "utf8")) as {
      name: string;
    };
    expect(overriddenName).not.toBe(pkg.name);
  });

  it("keeps the one-click per-user install shape the override depends on", () => {
    // The reasoning above only holds while the install is oneClick + per-user:
    // an assisted or per-machine installer uses productName for the directory
    // instead, and the separation would silently stop working.
    const config = builderConfig();
    expect(readScalar(config, "oneClick")).toBe("true");
    expect(readScalar(config, "perMachine")).toBe("false");
  });
});
