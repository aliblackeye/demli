import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyForegroundServicePlan,
  resolveVoiceForegroundServiceType,
  type ForegroundServiceApi,
  type VoiceForegroundServiceType,
} from "./foreground-service";

const require_ = createRequire(import.meta.url);
const MOBILE_ROOT = resolve(__dirname, "../..");
const REPO_ROOT = resolve(MOBILE_ROOT, "../..");

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(path, "utf8"));

/**
 * The FOUNDER REPRO these tests exist for (2026-07-30). Two people on mobile in a
 * DM call, both cameras on, one screen sharing her whole screen. She backgrounds
 * the app into the Android PiP window — mic, camera and share all keep working,
 * because a PiP activity is paused but still VISIBLE, which satisfies Android's
 * while-in-use rule on its own. She then DISMISSES the PiP window. Her mic goes
 * silent and her camera freezes; her screen share keeps flowing.
 *
 * The asymmetry is the whole diagnosis: foreground-service types do NOT
 * cross-grant. The share survived because its `mediaProjection` service was
 * running; mic and camera died because NO service covered them — the old policy
 * deliberately stood down while screen sharing, and no `camera` type existed at
 * all. Tracks stayed published, so the far side got silence and a frozen frame
 * rather than a mute badge: a source-level OS revocation, not a teardown of ours.
 */
describe("resolveVoiceForegroundServiceType", () => {
  it("runs for the statuses that hold a capture session", () => {
    for (const status of ["connected", "joining", "reconnecting"] as const) {
      expect(
        resolveVoiceForegroundServiceType({ status, cameraEnabled: false }),
      ).toBe("microphone");
    }
  });

  it("stands down for statuses that hold no capture", () => {
    for (const status of ["idle", "leaving", "error"] as const) {
      expect(
        resolveVoiceForegroundServiceType({ status, cameraEnabled: false }),
      ).toBeNull();
      expect(
        resolveVoiceForegroundServiceType({ status, cameraEnabled: true }),
      ).toBeNull();
    }
  });

  it("widens to cover the camera while the camera is on", () => {
    expect(
      resolveVoiceForegroundServiceType({
        status: "connected",
        cameraEnabled: true,
      }),
    ).toBe("microphone|camera");
  });

  /**
   * THE REGRESSION GUARD. The old policy took `screenShareEnabled` and returned
   * false for it, on the false premise that the MediaProjection service kept the
   * mic alive. Screen sharing is exactly when the background lifeline matters
   * most, so the parameter is gone: the coupling is now unrepresentable rather
   * than merely wrong. This asserts the signature never regains it — a behavioral
   * test cannot, because there is no longer an input to vary.
   */
  it("cannot be influenced by screen share at all", () => {
    const source = readFileSync(resolve(__dirname, "foreground-service.ts"), "utf8");
    const policy = source.slice(
      source.indexOf("export function resolveVoiceForegroundServiceType"),
    );
    const body = policy.slice(0, policy.indexOf("\n}\n"));
    expect(body).not.toMatch(/screenShare/i);
    expect(body).not.toMatch(/mediaProjection/i);
  });
});

/**
 * The library's JS `start()` begins with `if (!serviceRunning)` and otherwise
 * returns SILENTLY, so a second start() can never widen the type of a running
 * service. Miss that and the bookkeeping claims the camera is covered while the
 * native service is still microphone-only — the founder's camera freezes exactly
 * as before, with every unit test green. Hence stop-then-start on a type change.
 */
describe("applyForegroundServicePlan", () => {
  function fakeApi(): ForegroundServiceApi & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      register: () => {},
      start: async (config) => {
        calls.push(`start:${config.ServiceType}`);
      },
      stopAll: async () => {
        calls.push("stopAll");
        return undefined;
      },
    };
  }
  const notification = { title: "t", message: "m" };

  it("starts the service when nothing is running", async () => {
    const api = fakeApi();
    const next = await applyForegroundServicePlan(
      api,
      "microphone",
      null,
      notification,
    );
    expect(api.calls).toEqual(["start:microphone"]);
    expect(next).toBe("microphone");
  });

  it("stops before restarting when the type widens to cover the camera", async () => {
    const api = fakeApi();
    const next = await applyForegroundServicePlan(
      api,
      "microphone|camera",
      "microphone",
      notification,
    );
    expect(api.calls).toEqual(["stopAll", "start:microphone|camera"]);
    expect(next).toBe("microphone|camera");
  });

  it("stops before restarting when the type narrows again", async () => {
    const api = fakeApi();
    await applyForegroundServicePlan(
      api,
      "microphone",
      "microphone|camera",
      notification,
    );
    expect(api.calls).toEqual(["stopAll", "start:microphone"]);
  });

  it("does nothing when the running type already matches", async () => {
    const api = fakeApi();
    const next = await applyForegroundServicePlan(
      api,
      "microphone|camera",
      "microphone|camera",
      notification,
    );
    expect(api.calls).toEqual([]);
    expect(next).toBe("microphone|camera");
  });

  it("stops the service when the session ends", async () => {
    const api = fakeApi();
    const next = await applyForegroundServicePlan(
      api,
      null,
      "microphone",
      notification,
    );
    expect(api.calls).toEqual(["stopAll"]);
    expect(next).toBeNull();
  });
});

/**
 * SOURCE-INVARIANT tests over the native configuration.
 *
 * Everything that actually decides whether Android keeps capturing lives in the
 * manifest, the permission list and a native patch — none of it executes in a
 * unit test, and a device check cannot be automated here. So we assert the
 * config itself, and above all the ONE cross-file invariant Android enforces at
 * runtime: every type we may request must be within the manifest's declared
 * ceiling, or `startForeground` throws and the call loses its lifeline entirely.
 */
describe("android foreground service configuration", () => {
  const plugin = require_(
    resolve(MOBILE_ROOT, "plugins/with-foreground-service.js"),
  ) as {
    FOREGROUND_SERVICE_TYPE: string;
    SERVICE: string;
    applyForegroundServiceManifest: (app: Record<string, unknown>) => {
      service: { $: Record<string, string> }[];
    };
  };

  /** Every runtime type the policy can ever hand to startForeground. */
  const REACHABLE_TYPES: VoiceForegroundServiceType[] = [
    "microphone",
    "microphone|camera",
  ];

  it("declares the service with the microphone and camera types", () => {
    const app = plugin.applyForegroundServiceManifest({});
    const service = app.service.find(
      (s) => s.$["android:name"] === plugin.SERVICE,
    );
    expect(service).toBeDefined();
    const declared = (
      service?.$["android:foregroundServiceType"] ?? ""
    ).split("|");
    expect(declared).toContain("microphone");
    expect(declared).toContain("camera");
  });

  it("keeps every reachable runtime type within the manifest ceiling", () => {
    const declared = new Set(plugin.FOREGROUND_SERVICE_TYPE.split("|"));
    for (const type of REACHABLE_TYPES) {
      for (const part of type.split("|")) {
        expect(
          declared.has(part),
          `runtime type "${part}" is not declared in the manifest — startForeground would throw`,
        ).toBe(true);
      }
    }
  });

  it("requests the FOREGROUND_SERVICE permission for every declared type", () => {
    const appJson = readJson(resolve(MOBILE_ROOT, "app.json")) as {
      expo: { android: { permissions: string[] } };
    };
    const permissions = appJson.expo.android.permissions;
    for (const part of plugin.FOREGROUND_SERVICE_TYPE.split("|")) {
      expect(permissions).toContain(
        `android.permission.FOREGROUND_SERVICE_${part.toUpperCase()}`,
      );
    }
    // The runtime permissions those service types gate on.
    expect(permissions).toContain("android.permission.RECORD_AUDIO");
    expect(permissions).toContain("android.permission.CAMERA");
  });

  /**
   * `@supersami/rn-foreground-service` matched the WHOLE ServiceType string
   * against a switch, so "microphone|camera" missed every case and silently fell
   * through to FOREGROUND_SERVICE_TYPE_LOCATION — a permission we do not hold,
   * making startForeground throw. A pnpm patch splits and ORs the bits. If the
   * dependency is bumped, this fails rather than shipping a call with no
   * background lifeline at all.
   */
  it("keeps the native patch that allows a combined service type", () => {
    const installed = (
      readJson(
        require_.resolve("@supersami/rn-foreground-service/package.json"),
      ) as { version: string }
    ).version;
    const rootPkg = readJson(resolve(REPO_ROOT, "package.json")) as {
      pnpm: { patchedDependencies: Record<string, string> };
    };
    const key = `@supersami/rn-foreground-service@${installed}`;
    const patchPath: string | undefined =
      rootPkg.pnpm.patchedDependencies[key];
    expect(
      patchPath,
      `no pnpm patch registered for ${key} — a combined foregroundServiceType would silently become LOCATION`,
    ).toBeTruthy();

    const patch = readFileSync(resolve(REPO_ROOT, patchPath ?? ""), "utf8");
    expect(patch).toContain('customServiceType.split("\\\\|")');
    expect(patch).toContain("getSingleServiceTypeForAndroid10");
  });

  /**
   * The reason `applyForegroundServicePlan` stops before restarting. If a
   * dependency bump ever removes this guard the workaround becomes needless
   * churn (and the accompanying comment a lie), so we want to be told.
   */
  it("still needs the stop-then-start workaround for a type change", () => {
    const libSource = readFileSync(
      require_.resolve("@supersami/rn-foreground-service"),
      "utf8",
    );
    const start = libSource.slice(libSource.indexOf("const start = async ("));
    expect(
      start.slice(0, start.indexOf("ForegroundService.startService")),
      "library no longer swallows start() while running — revisit applyForegroundServicePlan",
    ).toContain("if (!serviceRunning)");
  });
});
