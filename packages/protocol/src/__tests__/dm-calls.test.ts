import { describe, expect, it } from "vitest";
import type { CallTarget, DmCall, Group, User } from "@demli/types";
import { SERVER_EVENT, serverEvent } from "../factories.js";
import {
  callTargetSchema,
  dmCallSchema,
  dmCallTokenResponseSchema,
  serverToClientEventSchema,
} from "../schemas.js";

const CALL_ID = "11111111-1111-1111-1111-111111111111";
const DM_ID = "22222222-2222-2222-2222-222222222222";
const GROUP_ID = "33333333-3333-3333-3333-333333333333";
const VOICE_CHANNEL_ID = "44444444-4444-4444-4444-444444444444";
const STREAM_ID = "55555555-5555-5555-5555-555555555555";
const CALLER_ID = "66666666-6666-6666-6666-666666666666";
const CALLEE_ID = "77777777-7777-7777-7777-777777777777";

const caller: User = {
  id: CALLER_ID,
  username: "ali",
  displayName: "Ali",
  avatarUrl: null,
  bio: null,
  createdAt: "2026-07-01T09:00:00.000Z",
};

const callee: User = {
  id: CALLEE_ID,
  username: "burak",
  displayName: "Burak",
  avatarUrl: null,
  bio: null,
  createdAt: "2026-07-02T09:00:00.000Z",
};

const dmTarget: CallTarget = { kind: "dm", dmId: DM_ID };
const groupTarget: CallTarget = {
  kind: "group",
  groupId: GROUP_ID,
  voiceChannelId: VOICE_CHANNEL_ID,
};

const upgradedGroup: Group = {
  id: GROUP_ID,
  name: "Ali, Burak & Mert",
  iconUrl: null,
  ownerId: CALLER_ID,
  streamId: STREAM_ID,
  createdAt: "2026-07-16T12:00:00.000Z",
};

const ringingCall: DmCall = {
  id: CALL_ID,
  dmId: DM_ID,
  roomName: `dmcall:${CALL_ID}`,
  callerId: CALLER_ID,
  calleeId: CALLEE_ID,
  media: "audio",
  status: "ringing",
  upgradedToGroupId: null,
  createdAt: "2026-07-16T12:00:00.000Z",
  expiresAt: "2026-07-16T12:00:30.000Z",
  startedAt: null,
  endedAt: null,
};

// ---------------------------------------------------------------------------
// CallTarget — both variants
// ---------------------------------------------------------------------------

describe("callTargetSchema", () => {
  it("parses the dm variant", () => {
    expect(callTargetSchema.parse(dmTarget)).toEqual(dmTarget);
  });

  it("parses the group variant", () => {
    expect(callTargetSchema.parse(groupTarget)).toEqual(groupTarget);
  });

  it("rejects an unknown discriminant", () => {
    expect(callTargetSchema.safeParse({ kind: "channel", channelId: DM_ID }).success).toBe(false);
  });

  it("rejects a group target missing its voiceChannelId", () => {
    expect(callTargetSchema.safeParse({ kind: "group", groupId: GROUP_ID }).success).toBe(false);
  });

  it("strips extra keys from the chosen variant", () => {
    const parsed = callTargetSchema.parse({ ...dmTarget, groupId: GROUP_ID });
    expect(parsed).toEqual(dmTarget);
    expect(parsed).not.toHaveProperty("groupId");
  });
});

// ---------------------------------------------------------------------------
// DmCall DTO + token response
// ---------------------------------------------------------------------------

describe("dmCallSchema", () => {
  it("accepts a ringing call (null started/ended)", () => {
    expect(dmCallSchema.parse(ringingCall)).toEqual(ringingCall);
  });

  it("accepts an active call", () => {
    const active: DmCall = {
      ...ringingCall,
      status: "active",
      startedAt: "2026-07-16T12:00:05.000Z",
      expiresAt: null,
    };
    expect(dmCallSchema.safeParse(active).success).toBe(true);
  });

  it("accepts an upgraded call linking its group", () => {
    const upgraded: DmCall = {
      ...ringingCall,
      status: "upgraded",
      startedAt: "2026-07-16T12:00:05.000Z",
      endedAt: "2026-07-16T12:03:00.000Z",
      expiresAt: null,
      upgradedToGroupId: GROUP_ID,
    };
    expect(dmCallSchema.safeParse(upgraded).success).toBe(true);
  });

  it("rejects an unknown status", () => {
    expect(dmCallSchema.safeParse({ ...ringingCall, status: "busy" }).success).toBe(false);
  });

  it("rejects an unknown media", () => {
    expect(dmCallSchema.safeParse({ ...ringingCall, media: "screen" }).success).toBe(false);
  });

  it("rejects a non-nullable field sent as undefined (upgradedToGroupId must be present)", () => {
    const { upgradedToGroupId: _drop, ...rest } = ringingCall;
    expect(dmCallSchema.safeParse(rest).success).toBe(false);
  });
});

describe("dmCallTokenResponseSchema", () => {
  const tokenResponse = {
    call: ringingCall,
    url: "wss://livekit.example",
    token: "jwt.token.value",
    roomName: `dmcall:${CALL_ID}`,
    identity: CALLER_ID,
    expiresAt: "2026-07-16T18:00:00.000Z",
  };

  it("accepts a token response embedding the call", () => {
    expect(dmCallTokenResponseSchema.parse(tokenResponse)).toEqual(tokenResponse);
  });

  it("rejects a token response with a malformed embedded call", () => {
    expect(
      dmCallTokenResponseSchema.safeParse({
        ...tokenResponse,
        call: { ...ringingCall, status: "nope" },
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Server events — acceptance
// ---------------------------------------------------------------------------

describe("dm-call server events — schema acceptance", () => {
  it("accepts call.invite for a DM target", () => {
    const result = serverToClientEventSchema.safeParse(
      serverEvent.callInvite({
        callId: CALL_ID,
        target: dmTarget,
        caller,
        media: "video",
        expiresAt: ringingCall.expiresAt!,
      }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts call.invite for a group-upgrade target", () => {
    const result = serverToClientEventSchema.safeParse(
      serverEvent.callInvite({
        callId: CALL_ID,
        target: groupTarget,
        caller,
        media: "audio",
        expiresAt: ringingCall.expiresAt!,
      }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts call.accepted", () => {
    const result = serverToClientEventSchema.safeParse(
      serverEvent.callAccepted({ callId: CALL_ID, target: dmTarget, callee }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts call.ended for every reason", () => {
    for (const reason of [
      "declined",
      "canceled",
      "timeout",
      "hung_up",
      "busy",
      "failed",
      "upgraded",
    ] as const) {
      const result = serverToClientEventSchema.safeParse(
        serverEvent.callEnded({ callId: CALL_ID, reason }),
      );
      expect(result.success).toBe(true);
    }
  });

  it("accepts call.upgraded", () => {
    const result = serverToClientEventSchema.safeParse(
      serverEvent.callUpgraded({
        callId: CALL_ID,
        group: upgradedGroup,
        voiceChannelId: VOICE_CHANNEL_ID,
      }),
    );
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Server events — rejection
// ---------------------------------------------------------------------------

describe("dm-call server events — schema rejection", () => {
  it("rejects call.invite missing the hydrated caller", () => {
    const result = serverToClientEventSchema.safeParse({
      type: "call.invite",
      payload: { callId: CALL_ID, target: dmTarget, media: "audio", expiresAt: "x" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects call.ended with an unknown reason", () => {
    const result = serverToClientEventSchema.safeParse({
      type: "call.ended",
      payload: { callId: CALL_ID, reason: "rejected" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects call.upgraded whose group is malformed (missing streamId)", () => {
    const { streamId: _drop, ...badGroup } = upgradedGroup;
    const result = serverToClientEventSchema.safeParse({
      type: "call.upgraded",
      payload: { callId: CALL_ID, group: badGroup, voiceChannelId: VOICE_CHANNEL_ID },
    });
    expect(result.success).toBe(false);
  });

  it("strips friendCode from an embedded caller (me-only leak guard)", () => {
    const parsed = serverToClientEventSchema.parse(
      serverEvent.callInvite({
        callId: CALL_ID,
        target: dmTarget,
        caller: { ...caller, friendCode: "ABCD2345" },
        media: "audio",
        expiresAt: ringingCall.expiresAt!,
      }),
    );
    expect(parsed.payload).not.toHaveProperty("caller.friendCode");
    if (parsed.type === "call.invite") {
      expect(parsed.payload.caller).not.toHaveProperty("friendCode");
    }
  });
});

// ---------------------------------------------------------------------------
// Factories — constants + wire round-trip
// ---------------------------------------------------------------------------

describe("dm-call factories", () => {
  it("exposes stable SERVER_EVENT name constants", () => {
    expect(SERVER_EVENT.callInvite).toBe("call.invite");
    expect(SERVER_EVENT.callAccepted).toBe("call.accepted");
    expect(SERVER_EVENT.callEnded).toBe("call.ended");
    expect(SERVER_EVENT.callUpgraded).toBe("call.upgraded");
  });

  it("tags each factory output with its SERVER_EVENT type", () => {
    expect(
      serverEvent.callInvite({
        callId: CALL_ID,
        target: dmTarget,
        caller,
        media: "audio",
        expiresAt: "x",
      }).type,
    ).toBe(SERVER_EVENT.callInvite);
    expect(serverEvent.callAccepted({ callId: CALL_ID, target: dmTarget, callee }).type).toBe(
      SERVER_EVENT.callAccepted,
    );
    expect(serverEvent.callEnded({ callId: CALL_ID, reason: "hung_up" }).type).toBe(
      SERVER_EVENT.callEnded,
    );
    expect(
      serverEvent.callUpgraded({
        callId: CALL_ID,
        group: upgradedGroup,
        voiceChannelId: VOICE_CHANNEL_ID,
      }).type,
    ).toBe(SERVER_EVENT.callUpgraded);
  });

  it("every call.* event survives a JSON wire round-trip and re-validates", () => {
    const events = [
      serverEvent.callInvite({
        callId: CALL_ID,
        target: dmTarget,
        caller,
        media: "video",
        expiresAt: ringingCall.expiresAt!,
      }),
      serverEvent.callInvite({
        callId: CALL_ID,
        target: groupTarget,
        caller,
        media: "audio",
        expiresAt: ringingCall.expiresAt!,
      }),
      serverEvent.callAccepted({ callId: CALL_ID, target: dmTarget, callee }),
      serverEvent.callEnded({ callId: CALL_ID, reason: "hung_up" }),
      serverEvent.callUpgraded({
        callId: CALL_ID,
        group: upgradedGroup,
        voiceChannelId: VOICE_CHANNEL_ID,
      }),
    ];
    for (const event of events) {
      const decoded = serverToClientEventSchema.parse(JSON.parse(JSON.stringify(event)));
      expect(decoded).toEqual(event);
    }
  });

  it("strips unknown top-level keys from a call.* event on parse", () => {
    const event = serverEvent.callEnded({ callId: CALL_ID, reason: "declined" });
    const decoded = serverToClientEventSchema.parse({
      ...event,
      payload: { ...event.payload, sneaky: "drop-me" },
    });
    expect(decoded).toEqual(event);
    expect(decoded.payload).not.toHaveProperty("sneaky");
  });
});
