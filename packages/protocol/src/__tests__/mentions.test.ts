import { describe, expect, it } from "vitest";
import {
  MENTION_AT_START,
  MENTION_EVERYONE,
  MENTION_HERE,
  contentMentionsUser,
  encodeMention,
  extractMentionTargets,
  isBroadcastMentionTarget,
} from "../mentions.js";

describe("mention encoding", () => {
  it("encodes a target into <@target> wire form", () => {
    expect(encodeMention("u1")).toBe("<@u1>");
    expect(encodeMention(MENTION_EVERYONE)).toBe("<@everyone>");
  });

  it("MENTION_AT_START matches a single mention at the start of a slice", () => {
    expect(MENTION_AT_START.exec("<@abc-123> rest")?.[1]).toBe("abc-123");
    expect(MENTION_AT_START.exec("plain <@x>")).toBeNull();
    expect(MENTION_AT_START.exec("<@>")).toBeNull(); // empty target
  });

  it("does not match an oversized target (bounded)", () => {
    const long = "a".repeat(70);
    expect(MENTION_AT_START.exec(`<@${long}>`)).toBeNull();
  });
});

describe("extractMentionTargets", () => {
  it("returns every target in document order, including repeats", () => {
    expect(
      extractMentionTargets("hi <@a> and <@b>, again <@a> plus <@everyone>"),
    ).toEqual(["a", "b", "a", "everyone"]);
  });

  it("returns [] when there are no mentions", () => {
    expect(extractMentionTargets("just text, a@b, and <not> a mention")).toEqual([]);
  });
});

describe("isBroadcastMentionTarget", () => {
  it("recognizes only the broadcast keywords", () => {
    expect(isBroadcastMentionTarget(MENTION_EVERYONE)).toBe(true);
    expect(isBroadcastMentionTarget(MENTION_HERE)).toBe(true);
    expect(isBroadcastMentionTarget("some-user-id")).toBe(false);
  });
});

describe("contentMentionsUser", () => {
  it("is true for a direct user mention", () => {
    expect(contentMentionsUser("yo <@u42> ping", "u42")).toBe(true);
    expect(contentMentionsUser("yo <@u42> ping", "u99")).toBe(false);
  });

  it("counts a broadcast mention as mentioning everyone by default", () => {
    expect(contentMentionsUser("<@here> standup", "anyone")).toBe(true);
    expect(contentMentionsUser("<@everyone> standup", "anyone")).toBe(true);
  });

  it("can exclude broadcast mentions when asked", () => {
    expect(contentMentionsUser("<@everyone> hi", "u1", false)).toBe(false);
    expect(contentMentionsUser("<@u1> hi", "u1", false)).toBe(true);
  });
});
