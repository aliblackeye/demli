import { describe, expect, it } from "vitest";
import type { Channel, FriendGroupMember, User } from "@demli/types";
import { SERVER_EVENT, serverEvent } from "../factories.js";
import {
  channelSchema,
  friendGroupMemberSchema,
  serverToClientEventSchema,
  userSchema,
} from "../schemas.js";

const GROUP_ID = "11111111-1111-1111-1111-111111111111";
const CHANNEL_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "33333333-3333-3333-3333-333333333333";

const sampleChannel: Channel = {
  id: CHANNEL_ID,
  groupId: GROUP_ID,
  kind: "voice",
  name: "lobby",
  position: 2,
  description: null,
  maxParticipants: 10,
  audioBitrateKbps: null,
  createdAt: "2026-07-09T10:00:00.000Z",
};

const sampleUser: User = {
  id: USER_ID,
  username: "ada",
  displayName: "Ada",
  avatarUrl: null,
  createdAt: "2026-07-09T09:00:00.000Z",
};

const sampleMember: FriendGroupMember = {
  groupId: GROUP_ID,
  userId: USER_ID,
  role: "member",
  roleIds: [],
  joinedAt: "2026-07-09T09:30:00.000Z",
};

// ---------------------------------------------------------------------------
// DTO schemas
// ---------------------------------------------------------------------------

describe("channelSchema", () => {
  it("accepts a full voice channel", () => {
    expect(channelSchema.parse(sampleChannel)).toEqual(sampleChannel);
  });

  it("accepts a minimal text channel (all optional meta omitted)", () => {
    const text: Channel = {
      id: CHANNEL_ID,
      groupId: GROUP_ID,
      kind: "text",
      name: "general",
      position: 0,
      createdAt: "2026-07-09T10:00:00.000Z",
    };
    expect(channelSchema.safeParse(text).success).toBe(true);
  });

  it("rejects an unknown channel kind", () => {
    expect(channelSchema.safeParse({ ...sampleChannel, kind: "forum" }).success).toBe(false);
  });

  it("rejects a missing groupId (the routing scope)", () => {
    const { groupId: _drop, ...rest } = sampleChannel;
    expect(channelSchema.safeParse(rest).success).toBe(false);
  });
});

describe("userSchema", () => {
  it("accepts a user with a null avatar", () => {
    expect(userSchema.parse(sampleUser)).toEqual(sampleUser);
  });

  it("rejects a missing displayName", () => {
    const { displayName: _drop, ...rest } = sampleUser;
    expect(userSchema.safeParse(rest).success).toBe(false);
  });
});

describe("friendGroupMemberSchema", () => {
  it("accepts a member with an explicit role and roleIds", () => {
    expect(friendGroupMemberSchema.parse(sampleMember)).toEqual(sampleMember);
  });

  it("accepts a member without roleIds (optional)", () => {
    const { roleIds: _drop, ...rest } = sampleMember;
    expect(friendGroupMemberSchema.safeParse(rest).success).toBe(true);
  });

  it("rejects an unknown member role", () => {
    expect(friendGroupMemberSchema.safeParse({ ...sampleMember, role: "admin" }).success).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Server event schemas — acceptance
// ---------------------------------------------------------------------------

describe("lifecycle server events — schema acceptance", () => {
  it("accepts channel.created carrying a full channel", () => {
    const result = serverToClientEventSchema.safeParse(serverEvent.channelCreated(sampleChannel));
    expect(result.success).toBe(true);
  });

  it("accepts channel.updated", () => {
    const result = serverToClientEventSchema.safeParse(
      serverEvent.channelUpdated({ ...sampleChannel, name: "renamed" }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts channel.deleted", () => {
    const result = serverToClientEventSchema.safeParse(
      serverEvent.channelDeleted({ channelId: CHANNEL_ID, groupId: GROUP_ID }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts member.joined", () => {
    const result = serverToClientEventSchema.safeParse(
      serverEvent.memberJoined({ groupId: GROUP_ID, member: sampleMember, user: sampleUser }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts member.left", () => {
    const result = serverToClientEventSchema.safeParse(
      serverEvent.memberLeft({ groupId: GROUP_ID, userId: USER_ID }),
    );
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Server event schemas — rejection
// ---------------------------------------------------------------------------

describe("lifecycle server events — schema rejection", () => {
  it("rejects channel.created carrying a malformed channel", () => {
    const result = serverToClientEventSchema.safeParse({
      type: "channel.created",
      payload: { ...sampleChannel, position: "second" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects channel.deleted missing the group-scope groupId", () => {
    const result = serverToClientEventSchema.safeParse({
      type: "channel.deleted",
      payload: { channelId: CHANNEL_ID },
    });
    expect(result.success).toBe(false);
  });

  it("rejects member.joined missing the user", () => {
    const result = serverToClientEventSchema.safeParse({
      type: "member.joined",
      payload: { groupId: GROUP_ID, member: sampleMember },
    });
    expect(result.success).toBe(false);
  });

  it("rejects member.left missing userId", () => {
    const result = serverToClientEventSchema.safeParse({
      type: "member.left",
      payload: { groupId: GROUP_ID },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Factories — constants and wire round-trip
// ---------------------------------------------------------------------------

describe("lifecycle factories", () => {
  it("exposes stable SERVER_EVENT name constants", () => {
    expect(SERVER_EVENT.channelCreated).toBe("channel.created");
    expect(SERVER_EVENT.channelUpdated).toBe("channel.updated");
    expect(SERVER_EVENT.channelDeleted).toBe("channel.deleted");
    expect(SERVER_EVENT.memberJoined).toBe("member.joined");
    expect(SERVER_EVENT.memberLeft).toBe("member.left");
  });

  it("builds events that survive a JSON wire round-trip and re-validate", () => {
    const event = serverEvent.memberJoined({
      groupId: GROUP_ID,
      member: sampleMember,
      user: sampleUser,
    });
    const decoded = serverToClientEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(decoded).toEqual(event);
  });

  it("tags each factory output with its SERVER_EVENT type", () => {
    expect(serverEvent.channelCreated(sampleChannel).type).toBe(SERVER_EVENT.channelCreated);
    expect(serverEvent.channelDeleted({ channelId: CHANNEL_ID, groupId: GROUP_ID }).type).toBe(
      SERVER_EVENT.channelDeleted,
    );
    expect(serverEvent.memberLeft({ groupId: GROUP_ID, userId: USER_ID }).type).toBe(
      SERVER_EVENT.memberLeft,
    );
  });
});
