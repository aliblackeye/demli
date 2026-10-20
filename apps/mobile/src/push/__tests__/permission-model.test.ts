import { describe, expect, it } from "vitest";
import {
  permissionAction,
  shouldRefreshToken,
  shouldShowPermissionBanner,
  TOKEN_REFRESH_MIN_INTERVAL_MS,
} from "../permission-model";

describe("shouldShowPermissionBanner", () => {
  it("shows only for a known denial that was not waved off", () => {
    expect(shouldShowPermissionBanner({ status: "denied", canAskAgain: false }, false)).toBe(true);
    expect(shouldShowPermissionBanner({ status: "denied", canAskAgain: true }, false)).toBe(true);
    expect(shouldShowPermissionBanner({ status: "denied", canAskAgain: false }, true)).toBe(false);
    expect(shouldShowPermissionBanner({ status: "granted", canAskAgain: true }, false)).toBe(false);
    // unknown = not read yet / read failed: never claim notifications are off
    expect(shouldShowPermissionBanner({ status: "unknown", canAskAgain: true }, false)).toBe(false);
  });
});

describe("permissionAction", () => {
  it("prompts in-app while allowed, otherwise opens system settings", () => {
    expect(permissionAction({ status: "denied", canAskAgain: true })).toBe("request");
    expect(permissionAction({ status: "denied", canAskAgain: false })).toBe("settings");
  });
});

describe("shouldRefreshToken", () => {
  it("refreshes on first foreground and on a fresh grant, then throttles", () => {
    expect(shouldRefreshToken({ now: 0, lastRefreshAt: null, justGranted: false })).toBe(true);
    expect(shouldRefreshToken({ now: 10, lastRefreshAt: 0, justGranted: true })).toBe(true);
    expect(shouldRefreshToken({ now: 10, lastRefreshAt: 0, justGranted: false })).toBe(false);
    expect(
      shouldRefreshToken({ now: TOKEN_REFRESH_MIN_INTERVAL_MS, lastRefreshAt: 0, justGranted: false }),
    ).toBe(true);
  });
});
