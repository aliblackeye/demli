import { describe, expect, it } from "vitest";
import { CUSTOM_STATUS_MAX_MINUTES } from "@demli/config";
import {
  buildCustomStatusInput,
  CUSTOM_STATUS_EXPIRY_CHOICES,
  customStatusExpiryMinutes,
  isCustomStatusExpired,
  visibleCustomStatus,
} from "../custom-status.js";

/** A fixed local wall-clock instant, built from LOCAL parts so the "today"
 *  arithmetic is the same in every timezone the tests run in. */
function localAt(h: number, m: number, s = 0): Date {
  return new Date(2026, 6, 27, h, m, s, 0);
}

describe("customStatusExpiryMinutes", () => {
  it("offers exactly the four documented choices, in display order", () => {
    expect(CUSTOM_STATUS_EXPIRY_CHOICES).toEqual(["never", "30m", "1h", "today"]);
  });

  it("sends nothing for 'never' — an omitted duration is what keeps it forever", () => {
    expect(customStatusExpiryMinutes("never", localAt(9, 0))).toBeUndefined();
  });

  it("maps the fixed durations to their literal minute counts", () => {
    expect(customStatusExpiryMinutes("30m", localAt(9, 0))).toBe(30);
    expect(customStatusExpiryMinutes("1h", localAt(9, 0))).toBe(60);
  });

  it("'today' is minutes until the user's OWN local midnight", () => {
    // 09:00 -> 15h to midnight.
    expect(customStatusExpiryMinutes("today", localAt(9, 0))).toBe(15 * 60);
    // 23:00 -> one hour left.
    expect(customStatusExpiryMinutes("today", localAt(23, 0))).toBe(60);
  });

  it("floors 'today' at 1 minute so 23:59:30 is not rejected as zero", () => {
    expect(customStatusExpiryMinutes("today", localAt(23, 59, 30))).toBe(1);
  });

  it("caps 'today' at the server ceiling if the device clock is nonsense", () => {
    // A device whose clock believes midnight is a month away.
    const skewed = new Date(2026, 6, 27, 0, 0, 0, 0);
    skewed.setHours(-24 * 40, 0, 0, 0); // next "midnight" 40 days out
    const minutes = customStatusExpiryMinutes("today", skewed);
    expect(minutes).toBeLessThanOrEqual(CUSTOM_STATUS_MAX_MINUTES);
  });

  it("produces a timestamp that lands on the right instant when applied", () => {
    const now = localAt(14, 30);
    const minutes = customStatusExpiryMinutes("30m", now) as number;
    const expiresAt = new Date(now.getTime() + minutes * 60_000);
    expect(expiresAt.getHours()).toBe(15);
    expect(expiresAt.getMinutes()).toBe(0);
  });

  it("'today' applied to the clock lands exactly on the next midnight", () => {
    const now = localAt(18, 12);
    const minutes = customStatusExpiryMinutes("today", now) as number;
    const expiresAt = new Date(now.getTime() + minutes * 60_000);
    expect(expiresAt.getDate()).toBe(28);
    expect(expiresAt.getHours()).toBe(0);
    expect(expiresAt.getMinutes()).toBe(0);
  });
});

describe("buildCustomStatusInput", () => {
  it("trims and carries the duration", () => {
    expect(buildCustomStatusInput("  heads down  ", "1h", localAt(9, 0))).toEqual({
      text: "heads down",
      expiresInMinutes: 60,
    });
  });

  it("omits the duration entirely for 'never'", () => {
    expect(buildCustomStatusInput("brb", "never", localAt(9, 0))).toEqual({ text: "brb" });
  });

  it("an empty or whitespace-only box CLEARS — and never carries a duration", () => {
    expect(buildCustomStatusInput("", "1h", localAt(9, 0))).toEqual({ text: null });
    expect(buildCustomStatusInput("   \n ", "today", localAt(9, 0))).toEqual({ text: null });
  });
});

describe("visibleCustomStatus", () => {
  const now = localAt(12, 0);

  it("shows a status with no expiry", () => {
    expect(visibleCustomStatus({ customStatus: "at the gym" }, now)).toBe("at the gym");
  });

  it("shows a status whose expiry is still ahead", () => {
    const future = new Date(now.getTime() + 60_000).toISOString();
    expect(visibleCustomStatus({ customStatus: "brb", customStatusExpiresAt: future }, now)).toBe(
      "brb",
    );
  });

  it("HIDES a status whose expiry has passed while the app stayed open", () => {
    const past = new Date(now.getTime() - 1_000).toISOString();
    expect(
      visibleCustomStatus({ customStatus: "heads down", customStatusExpiresAt: past }, now),
    ).toBeNull();
  });

  it("hides it exactly AT the expiry instant, not a tick later", () => {
    const at = new Date(now.getTime()).toISOString();
    expect(visibleCustomStatus({ customStatus: "x", customStatusExpiresAt: at }, now)).toBeNull();
  });

  it("treats blank / missing / null text as nothing to show", () => {
    expect(visibleCustomStatus({ customStatus: "   " }, now)).toBeNull();
    expect(visibleCustomStatus({ customStatus: null }, now)).toBeNull();
    expect(visibleCustomStatus({}, now)).toBeNull();
    expect(visibleCustomStatus(null, now)).toBeNull();
    expect(visibleCustomStatus(undefined, now)).toBeNull();
  });

  it("keeps showing a status whose expiry timestamp is unparseable", () => {
    // A bad timestamp must not blank out something the user really set — the
    // next fetch is authoritative.
    expect(
      visibleCustomStatus({ customStatus: "still here", customStatusExpiresAt: "not-a-date" }, now),
    ).toBe("still here");
  });

  it("trims what it returns", () => {
    expect(visibleCustomStatus({ customStatus: "  spaced  " }, now)).toBe("spaced");
  });
});

describe("isCustomStatusExpired", () => {
  const now = localAt(12, 0);

  it("no expiry means never expired", () => {
    expect(isCustomStatusExpired(null, now)).toBe(false);
    expect(isCustomStatusExpired(undefined, now)).toBe(false);
    expect(isCustomStatusExpired("", now)).toBe(false);
  });

  it("past is expired, future is not", () => {
    expect(isCustomStatusExpired(new Date(now.getTime() - 1).toISOString(), now)).toBe(true);
    expect(isCustomStatusExpired(new Date(now.getTime() + 1).toISOString(), now)).toBe(false);
  });
});
