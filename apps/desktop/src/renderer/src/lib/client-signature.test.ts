import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { formatClientSignature, isValidClientSignature } from "@demli/config";
import { detectClientApp } from "./client-signature";

/**
 * This surface has to identify itself to the server's client gate, and it is two
 * surfaces sharing one file: apps/web mounts this exact renderer, so the mark
 * must resolve to `demli-web/…` in a browser and `demli-desktop/…` in Electron
 * off the same code.
 *
 * The consequence of getting it wrong is not a wrong label — it is a refused
 * client. So this pins the detection, the shape, and the fact that both
 * transports are actually WIRED to it.
 */

const here = dirname(fileURLToPath(import.meta.url));

function source(relativePath: string): string {
  return readFileSync(resolve(here, relativePath), "utf8");
}

function stubBridge(appInfo: unknown): void {
  Object.defineProperty(globalThis, "demli", {
    value: appInfo === undefined ? undefined : { appInfo },
    configurable: true,
    writable: true,
  });
}

describe("detectClientApp", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis as object, "demli");
  });

  it("reports web when the browser shim is what installed the bridge", () => {
    stubBridge({ platform: "web", version: "1.2.3" });
    expect(detectClientApp()).toBe("web");
  });

  it("reports desktop for a real Electron platform", () => {
    for (const platform of ["win32", "darwin", "linux"]) {
      stubBridge({ platform, version: "0.0.81" });
      expect(detectClientApp(), platform).toBe("desktop");
    }
  });

  it("falls back to desktop rather than failing when the bridge is missing", () => {
    // An absent bridge means the preload has not run — only possible inside
    // Electron, since the web entry installs its shim before this module can be
    // imported. Guessing is fine; sending no mark at all is not.
    stubBridge(undefined);
    expect(detectClientApp()).toBe("desktop");
    stubBridge(null);
    expect(detectClientApp()).toBe("desktop");
  });
});

describe("CLIENT_SIGNATURE", () => {
  it("is a mark the server's gate accepts, whatever the bridge reports", async () => {
    // Cover the version the module could actually read, including the broken
    // shapes: every one must still yield a VALID mark, because an invalid mark
    // is indistinguishable from an old build and gets the user locked out.
    for (const version of [undefined, null, "", "   ", 0, "0.0.81"]) {
      for (const app of ["desktop", "web"] as const) {
        expect(isValidClientSignature(formatClientSignature(app, version))).toBe(true);
      }
    }

    // And the real module-level value, resolved from whatever this environment
    // looks like.
    const { CLIENT_SIGNATURE } = await import("./client-signature");
    expect(isValidClientSignature(CLIENT_SIGNATURE)).toBe(true);
    expect(CLIENT_SIGNATURE.startsWith("demli-")).toBe(true);
  });

  it("is wired into BOTH transports", () => {
    // Gating only one of them is a hole, not a partial fix: an HTTP-only mark
    // leaves a retired build reading live chat over its socket. Neither wiring
    // is visible to a unit test of either client, so assert the call sites.
    const apiClient = source("./api-client.ts");
    expect(apiClient).toContain('from "./client-signature"');
    expect(apiClient).toMatch(/clientSignature:\s*CLIENT_SIGNATURE/);

    const connection = source("../realtime/connection.ts");
    expect(connection).toContain('from "../lib/client-signature"');
    expect(connection).toMatch(/clientSignature:\s*CLIENT_SIGNATURE/);
  });
});
