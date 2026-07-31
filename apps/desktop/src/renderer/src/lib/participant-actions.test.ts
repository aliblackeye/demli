import { describe, expect, it } from "vitest";
import {
  hasModerationActions,
  socialActionFor,
  visibleParticipantActions,
  type ParticipantMenuContext,
} from "./participant-actions";

/**
 * The permission gate is the security-relevant part of the voice-participant menu
 * (§35). These lock the contract the React menu renders: an UNAUTHORIZED viewer
 * only ever sees social + invite; kick/ban/disconnect appear ONLY for an
 * authorized viewer, and NEVER against the owner or oneself.
 */

const base: ParticipantMenuContext = {
  isSelf: false,
  isOwner: false,
  canModerate: false,
  inVoice: true,
  friendship: "none",
};

describe("socialActionFor", () => {
  it("maps each friendship state to the ProfileCard-equivalent action", () => {
    expect(socialActionFor("friends")).toBe("message");
    expect(socialActionFor("none")).toBe("addFriend");
    expect(socialActionFor("outgoing")).toBe("cancelRequest");
    expect(socialActionFor("incoming")).toBe("acceptRequest");
  });

  it("shows no social action while the friendship is still loading", () => {
    expect(socialActionFor("unknown")).toBeNull();
  });
});

describe("visibleParticipantActions", () => {
  it("shows nothing for the local user (no self-actions)", () => {
    expect(visibleParticipantActions({ ...base, isSelf: true, canModerate: true })).toEqual([]);
  });

  it("gives an UNAUTHORIZED viewer only social + invite — no moderation", () => {
    const actions = visibleParticipantActions({ ...base, friendship: "none", canModerate: false });
    expect(actions).toEqual(["addFriend", "invite"]);
    expect(hasModerationActions({ ...base, canModerate: false })).toBe(false);
  });

  it("adds disconnect/kick/ban for an AUTHORIZED viewer", () => {
    const actions = visibleParticipantActions({
      ...base,
      friendship: "friends",
      canModerate: true,
    });
    expect(actions).toEqual(["message", "invite", "disconnect", "kick", "ban"]);
    expect(hasModerationActions({ ...base, canModerate: true })).toBe(true);
  });

  it("never offers moderation against the server owner, even to an authorized viewer", () => {
    const actions = visibleParticipantActions({
      ...base,
      friendship: "friends",
      canModerate: true,
      isOwner: true,
    });
    expect(actions).toEqual(["message", "invite"]);
    expect(hasModerationActions({ ...base, canModerate: true, isOwner: true })).toBe(false);
  });

  it("omits disconnect when the target is not in a voice channel", () => {
    const actions = visibleParticipantActions({
      ...base,
      friendship: "none",
      canModerate: true,
      inVoice: false,
    });
    expect(actions).toEqual(["addFriend", "invite", "kick", "ban"]);
  });

  it("shows only invite (+ moderation) while friendship is still unknown", () => {
    expect(
      visibleParticipantActions({ ...base, friendship: "unknown", canModerate: false }),
    ).toEqual(["invite"]);
    expect(
      visibleParticipantActions({ ...base, friendship: "unknown", canModerate: true }),
    ).toEqual(["invite", "disconnect", "kick", "ban"]);
  });
});
