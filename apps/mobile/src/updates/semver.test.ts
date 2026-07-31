import { describe, expect, it } from "vitest";
import { compareVersions, isOlder, isValidVersion } from "./semver";
import { apkFileName, decideNativeUpdate } from "./native-update";

describe("compareVersions", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.3.0", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("1.3.1", "1.3.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "2.0.0")).toBeLessThan(0);
    expect(compareVersions("1.2.0", "1.3.0")).toBeLessThan(0);
    expect(compareVersions("1.3.0", "1.3.1")).toBeLessThan(0);
  });

  it("treats equal versions as 0", () => {
    expect(compareVersions("1.3.0", "1.3.0")).toBe(0);
    expect(compareVersions("0.0.0", "0.0.0")).toBe(0);
  });

  it("treats missing trailing segments as 0 (different lengths)", () => {
    expect(compareVersions("1.3", "1.3.0")).toBe(0);
    expect(compareVersions("1", "1.0.0")).toBe(0);
    expect(compareVersions("1.3", "1.3.1")).toBeLessThan(0);
    expect(compareVersions("1.4", "1.3.9")).toBeGreaterThan(0);
  });

  it("handles multi-digit segments numerically, not lexically", () => {
    // "10" > "9" numerically (a naive string compare would get this wrong).
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.3.10", "1.3.2")).toBeGreaterThan(0);
  });

  it("collapses non-numeric segments to 0 rather than throwing", () => {
    expect(compareVersions("1.x.0", "1.0.0")).toBe(0);
  });
});

describe("isOlder", () => {
  it("is true only when current strictly precedes target", () => {
    expect(isOlder("1.2.0", "1.3.0")).toBe(true);
    expect(isOlder("1.3.0", "1.3.0")).toBe(false);
    expect(isOlder("1.4.0", "1.3.0")).toBe(false);
  });
});

describe("isValidVersion", () => {
  it("accepts plain numeric dotted versions", () => {
    expect(isValidVersion("1")).toBe(true);
    expect(isValidVersion("1.3")).toBe(true);
    expect(isValidVersion("1.3.0")).toBe(true);
    expect(isValidVersion(" 1.3.0 ")).toBe(true);
  });

  it("rejects empty, prerelease, and policy-style values", () => {
    expect(isValidVersion("")).toBe(false);
    expect(isValidVersion("1.3.0-beta")).toBe(false);
    expect(isValidVersion("sdk-52")).toBe(false);
    expect(isValidVersion("v1.3.0")).toBe(false);
  });
});

describe("decideNativeUpdate", () => {
  const LATEST = "1.3.0";

  it("returns none when the device is on the latest runtime", () => {
    expect(
      decideNativeUpdate({ currentRuntime: "1.3.0", latestRuntimeVersion: LATEST }),
    ).toBe("none");
  });

  it("returns none when the device is ahead of the advertised latest", () => {
    expect(
      decideNativeUpdate({ currentRuntime: "1.4.0", latestRuntimeVersion: LATEST }),
    ).toBe("none");
  });

  it("returns optional when a newer runtime exists but no floor is set", () => {
    expect(
      decideNativeUpdate({ currentRuntime: "1.2.0", latestRuntimeVersion: LATEST }),
    ).toBe("optional");
  });

  it("returns optional when below latest but at or above the floor", () => {
    expect(
      decideNativeUpdate({
        currentRuntime: "1.2.0",
        latestRuntimeVersion: LATEST,
        minSupportedRuntimeVersion: "1.2.0",
      }),
    ).toBe("optional");
  });

  it("returns forced when below the supported floor", () => {
    expect(
      decideNativeUpdate({
        currentRuntime: "1.1.0",
        latestRuntimeVersion: LATEST,
        minSupportedRuntimeVersion: "1.2.0",
      }),
    ).toBe("forced");
  });

  it("never blocks on an unknown or garbage device runtime", () => {
    expect(
      decideNativeUpdate({ currentRuntime: null, latestRuntimeVersion: LATEST }),
    ).toBe("none");
    expect(
      decideNativeUpdate({ currentRuntime: undefined, latestRuntimeVersion: LATEST }),
    ).toBe("none");
    expect(
      decideNativeUpdate({
        currentRuntime: "sdk-52",
        latestRuntimeVersion: LATEST,
        minSupportedRuntimeVersion: "1.2.0",
      }),
    ).toBe("none");
  });

  it("ignores a misconfigured (non-numeric) advertised latest", () => {
    expect(
      decideNativeUpdate({ currentRuntime: "1.2.0", latestRuntimeVersion: "latest" }),
    ).toBe("none");
  });

  it("ignores a non-numeric floor but still evaluates optional", () => {
    expect(
      decideNativeUpdate({
        currentRuntime: "1.2.0",
        latestRuntimeVersion: LATEST,
        minSupportedRuntimeVersion: "oops",
      }),
    ).toBe("optional");
  });
});

describe("apkFileName", () => {
  it("derives a stable, version-keyed filename", () => {
    expect(apkFileName("1.4.0")).toBe("demli-1.4.0.apk");
    // Same version → same name, so a cancelled install re-launches without re-download.
    expect(apkFileName("1.4.0")).toBe(apkFileName("1.4.0"));
  });

  it("keeps distinct versions in distinct files (stale cleanup can tell them apart)", () => {
    expect(apkFileName("1.4.0")).not.toBe(apkFileName("1.3.0"));
  });

  it("sanitises unsafe characters so a garbage version can't escape the directory", () => {
    expect(apkFileName("../../evil")).toBe("demli-.._.._evil.apk");
    expect(apkFileName("1.4.0/../x")).toBe("demli-1.4.0_.._x.apk");
    expect(apkFileName("1 4 0")).toBe("demli-1_4_0.apk");
  });
});
