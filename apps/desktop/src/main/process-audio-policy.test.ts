import { describe, expect, it } from "vitest";
import {
  appTargetIncludesDemli,
  helperCaptureArgs,
  hwndOfWindowSource,
  parsePidLines,
  platformSupport,
  processAudioStartSchema,
  windowsBuildFromRelease,
} from "./process-audio-policy";

describe("process-audio policy", () => {
  it("reads the Windows build from os.release()", () => {
    expect(windowsBuildFromRelease("10.0.22631")).toBe(22631);
    expect(windowsBuildFromRelease("10.0.19045")).toBe(19045);
    expect(windowsBuildFromRelease("garbage")).toBeNull();
  });

  it("supports process capture only on Windows build 20348+", () => {
    expect(platformSupport("win32", "10.0.22631")).toEqual({ supported: true });
    expect(platformSupport("win32", "10.0.20348")).toEqual({ supported: true });
    expect(platformSupport("win32", "10.0.19045")).toEqual({ supported: false, reason: "unsupported_os" });
    expect(platformSupport("darwin", "23.1.0")).toEqual({ supported: false, reason: "unsupported_platform" });
  });

  it("'system' always EXCLUDES the given tree, 'app' INCLUDES it", () => {
    expect(helperCaptureArgs("system", 4242)).toEqual(["4242", "exclude"]);
    expect(helperCaptureArgs("app", 77)).toEqual(["77", "include"]);
  });

  it("refuses an 'app' target whose tree would contain Demli", () => {
    // Demli's own window.
    expect(appTargetIncludesDemli(100, 100, [50, 4])).toBe(true);
    // Explorer launched Demli: sharing an Explorer window would capture the call.
    expect(appTargetIncludesDemli(50, 100, [50, 4])).toBe(true);
    // An unrelated browser.
    expect(appTargetIncludesDemli(900, 100, [50, 4])).toBe(false);
  });

  it("parses helper PID output defensively", () => {
    expect(parsePidLines("123\r\n456\n\nnope\n-1\n0\n")).toEqual([123, 456]);
  });

  it("takes the HWND only from a well-formed window source id", () => {
    expect(hwndOfWindowSource("window:8390994:0")).toBe("8390994");
    expect(hwndOfWindowSource("screen:0:0")).toBeNull();
    expect(hwndOfWindowSource("window:12;rm:0")).toBeNull();
  });

  it("accepts only the two request shapes — never a raw PID", () => {
    expect(processAudioStartSchema.safeParse({ mode: "system" }).success).toBe(true);
    expect(processAudioStartSchema.safeParse({ mode: "app", sourceId: "window:1:0" }).success).toBe(true);
    expect(processAudioStartSchema.safeParse({ mode: "system", pid: 1 }).success).toBe(false);
    expect(processAudioStartSchema.safeParse({ mode: "app" }).success).toBe(false);
    expect(processAudioStartSchema.safeParse({ sourceId: "window:1:0" }).success).toBe(false);
    expect(processAudioStartSchema.safeParse({ mode: "loopback" }).success).toBe(false);
  });
});
