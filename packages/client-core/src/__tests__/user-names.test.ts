/**
 * Name resolution order (ADR 0019 §2).
 *
 * This looks like a trivial `??` chain, and that is exactly why it is tested:
 * the two nickname layers have DIFFERENT audiences, so getting the order wrong
 * is not a cosmetic bug. If a server nickname could beat a private one, a server
 * could override the label a viewer chose for a person; the rules below are the
 * contract every surface (roster, message author, DM list, profile card, mention
 * token) resolves through.
 */

import { describe, expect, it } from "vitest";
import {
  realNameBehindNickname,
  resolveUserName,
  resolveUserNameSource,
} from "../user-names.js";

const FULL = {
  privateNickname: "Bebiş",
  serverNickname: "Moderatör Ali",
  displayName: "Ali Karagöz",
  username: "ali",
  fallback: "user-1",
};

describe("precedence", () => {
  it("prefers the PRIVATE nickname over everything", () => {
    expect(resolveUserName(FULL)).toBe("Bebiş");
    expect(resolveUserNameSource(FULL)).toBe("privateNickname");
  });

  it("falls to the SERVER nickname when there is no private one", () => {
    expect(resolveUserName({ ...FULL, privateNickname: null })).toBe("Moderatör Ali");
    expect(resolveUserNameSource({ ...FULL, privateNickname: null })).toBe("serverNickname");
  });

  it("falls to displayName when neither nickname is set", () => {
    expect(resolveUserName({ ...FULL, privateNickname: null, serverNickname: null })).toBe(
      "Ali Karagöz",
    );
  });

  it("falls to the username when there is no display name", () => {
    expect(
      resolveUserName({ ...FULL, privateNickname: null, serverNickname: null, displayName: null }),
    ).toBe("ali");
  });

  it("falls to the caller's fallback (usually the id) as a last resort", () => {
    expect(
      resolveUserName({
        privateNickname: null,
        serverNickname: null,
        displayName: null,
        username: null,
        fallback: "user-1",
      }),
    ).toBe("user-1");
  });

  it("returns an empty string when even the fallback is absent", () => {
    expect(resolveUserName({})).toBe("");
  });

  it("a server nickname NEVER overrides a private one — the privacy-critical case", () => {
    const withBoth = { privateNickname: "My Name For Them", serverNickname: "Server Label" };
    expect(resolveUserName(withBoth)).toBe("My Name For Them");
  });
});

describe("blank handling", () => {
  it("treats a whitespace-only nickname as absent at every layer", () => {
    expect(resolveUserName({ ...FULL, privateNickname: "   " })).toBe("Moderatör Ali");
    expect(resolveUserName({ ...FULL, privateNickname: "", serverNickname: "\t" })).toBe(
      "Ali Karagöz",
    );
  });

  it("trims the resolved name", () => {
    expect(resolveUserName({ privateNickname: "  Bebiş  " })).toBe("Bebiş");
  });

  it("treats undefined and null identically", () => {
    expect(resolveUserName({ privateNickname: undefined, displayName: "Ali" })).toBe("Ali");
    expect(resolveUserName({ privateNickname: null, displayName: "Ali" })).toBe("Ali");
  });
});

describe("realNameBehindNickname", () => {
  it("reports the real name whenever a nickname is in force", () => {
    expect(realNameBehindNickname(FULL)).toBe("Ali Karagöz");
    expect(realNameBehindNickname({ ...FULL, privateNickname: null })).toBe("Ali Karagöz");
  });

  it("reports nothing when the displayed name IS the real name", () => {
    expect(realNameBehindNickname({ ...FULL, privateNickname: null, serverNickname: null })).toBe(
      null,
    );
  });

  it("falls back to the username when there is no display name", () => {
    expect(realNameBehindNickname({ privateNickname: "Bebiş", username: "ali" })).toBe("ali");
  });
});
