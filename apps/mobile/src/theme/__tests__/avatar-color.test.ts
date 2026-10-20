import { describe, expect, it } from "vitest";
import {
  AVATAR_GLOW_OPACITY,
  avatarHue,
  avatarTileGlow,
  avatarTileGradient,
  avatarTileSolid,
} from "../avatar-color";

/**
 * Locks the SHARED cameraless-tile color contract (theme/avatar-color.ts). The
 * desktop renderer must port the identical algorithm, so these golden values are
 * the cross-platform reference: if desktop produces a different hue for the same
 * userId, the two apps disagree and this table is what to check against.
 */
describe("avatar-color (shared contract with desktop)", () => {
  // userId → expected hue (computed from the documented Java-string-hash algorithm)
  const goldenHues: Record<string, number> = {
    "user-1": 135,
    "user-2": 136,
    ali: 190,
    burak: 353,
    mert: 290,
    can: 336,
    "00000000-0000-0000-0000-000000000001": 49,
    z: 122,
  };

  it("maps each userId to its golden hue", () => {
    for (const [userId, hue] of Object.entries(goldenHues)) {
      expect(avatarHue(userId), userId).toBe(hue);
    }
  });

  it("always returns a hue in [0, 360)", () => {
    for (const userId of ["", "a", "😀", "very-long-identity-string-1234567890"]) {
      const hue = avatarHue(userId);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      expect(Number.isInteger(hue)).toBe(true);
    }
  });

  it("is deterministic", () => {
    expect(avatarHue("burak")).toBe(avatarHue("burak"));
  });

  it("builds the documented gradient + solid HSL strings", () => {
    expect(avatarTileGradient("ali")).toEqual({
      from: "hsl(190, 55%, 30%)",
      to: "hsl(206, 60%, 18%)",
    });
    expect(avatarTileSolid("ali")).toBe("hsl(190, 55%, 24%)");
  });

  it("wraps the gradient's shifted hue past 360", () => {
    // burak hue = 353; 353 + 16 = 369 → 9
    expect(avatarTileGradient("burak")).toEqual({
      from: "hsl(353, 55%, 30%)",
      to: "hsl(9, 60%, 18%)",
    });
  });

  it("builds the identity glow on the same hue as the desktop tile disc", () => {
    // Desktop AvatarTile: hsl(hue 60% 50%) at opacity 0.16 over bg-surface.
    expect(avatarTileGlow("ali")).toBe("hsl(190, 60%, 50%)");
    expect(avatarTileGlow("burak")).toBe("hsl(353, 60%, 50%)");
    expect(AVATAR_GLOW_OPACITY).toBe(0.16);
  });
});
