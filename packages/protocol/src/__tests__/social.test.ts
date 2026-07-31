import { describe, expect, it } from "vitest";
import type { Dm, Friendship, User } from "@demli/types";
import { SERVER_EVENT, serverEvent } from "../factories.js";
import {
  dmSchema,
  friendshipSchema,
  serverToClientEventSchema,
  userSchema,
} from "../schemas.js";

// Canonical pair: USER_A < USER_B (uuid total order), as the DB enforces.
const USER_A = "33333333-3333-3333-3333-333333333333";
const USER_B = "44444444-4444-4444-4444-444444444444";
const DM_ID = "55555555-5555-5555-5555-555555555555";
const STREAM_ID = "66666666-6666-6666-6666-666666666666";

const samplePending: Friendship = {
  userA: USER_A,
  userB: USER_B,
  status: "pending",
  requestedBy: USER_B,
  createdAt: "2026-07-10T09:00:00.000Z",
  updatedAt: null,
};

const sampleAccepted: Friendship = {
  ...samplePending,
  status: "accepted",
  updatedAt: "2026-07-10T10:00:00.000Z",
};

const sampleUser: User = {
  id: USER_B,
  username: "grace",
  displayName: "Grace",
  avatarUrl: null,
  bio: "compilers & coffee",
  createdAt: "2026-07-09T09:00:00.000Z",
};

const sampleDm: Dm = {
  id: DM_ID,
  streamId: STREAM_ID,
  participant: sampleUser,
  createdAt: "2026-07-10T11:00:00.000Z",
};

// ---------------------------------------------------------------------------
// DTO schemas
// ---------------------------------------------------------------------------

describe("friendshipSchema", () => {
  it("accepts a pending friendship (null updatedAt)", () => {
    expect(friendshipSchema.parse(samplePending)).toEqual(samplePending);
  });

  it("accepts an accepted friendship", () => {
    expect(friendshipSchema.safeParse(sampleAccepted).success).toBe(true);
  });

  it("rejects an unknown status (blocking is NOT a friendship status)", () => {
    expect(
      friendshipSchema.safeParse({ ...samplePending, status: "blocked" }).success,
    ).toBe(false);
  });

  it("rejects a missing requestedBy (accept-guard depends on it)", () => {
    const { requestedBy: _drop, ...rest } = samplePending;
    expect(friendshipSchema.safeParse(rest).success).toBe(false);
  });
});

describe("dmSchema", () => {
  it("accepts a DM with a hydrated participant", () => {
    expect(dmSchema.parse(sampleDm)).toEqual(sampleDm);
  });

  it("rejects a missing streamId (the DM's message channel)", () => {
    const { streamId: _drop, ...rest } = sampleDm;
    expect(dmSchema.safeParse(rest).success).toBe(false);
  });
});

describe("userSchema — social fields", () => {
  it("accepts a user carrying a bio and one without", () => {
    expect(userSchema.safeParse(sampleUser).success).toBe(true);
    const { bio: _drop, ...rest } = sampleUser;
    expect(userSchema.safeParse(rest).success).toBe(true);
  });

  it("STRIPS friendCode — the me-only code never survives the codec", () => {
    const leaked = { ...sampleUser, friendCode: "ABCD2345" };
    const parsed = userSchema.parse(leaked);
    expect(parsed).not.toHaveProperty("friendCode");
  });
});

// ---------------------------------------------------------------------------
// Server event schemas — acceptance
// ---------------------------------------------------------------------------

describe("social server events — schema acceptance", () => {
  it("accepts friend.request_received", () => {
    const result = serverToClientEventSchema.safeParse(
      serverEvent.friendRequestReceived({ request: samplePending, requester: sampleUser }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts friend.request_accepted", () => {
    const result = serverToClientEventSchema.safeParse(
      serverEvent.friendRequestAccepted({ friendship: sampleAccepted, friend: sampleUser }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts friend.removed", () => {
    const result = serverToClientEventSchema.safeParse(
      serverEvent.friendRemoved({ userId: USER_B }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts dm.created", () => {
    const result = serverToClientEventSchema.safeParse(serverEvent.dmCreated({ dm: sampleDm }));
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Server event schemas — rejection
// ---------------------------------------------------------------------------

describe("social server events — schema rejection", () => {
  it("rejects friend.request_received missing the hydrated requester", () => {
    const result = serverToClientEventSchema.safeParse({
      type: "friend.request_received",
      payload: { request: samplePending },
    });
    expect(result.success).toBe(false);
  });

  it("rejects friend.request_accepted carrying a malformed friendship", () => {
    const result = serverToClientEventSchema.safeParse({
      type: "friend.request_accepted",
      payload: { friendship: { ...sampleAccepted, status: "declined" }, friend: sampleUser },
    });
    expect(result.success).toBe(false);
  });

  it("rejects friend.removed missing userId", () => {
    const result = serverToClientEventSchema.safeParse({
      type: "friend.removed",
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects dm.created missing the dm", () => {
    const result = serverToClientEventSchema.safeParse({
      type: "dm.created",
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects dm.created whose participant is malformed", () => {
    const result = serverToClientEventSchema.safeParse({
      type: "dm.created",
      payload: { dm: { ...sampleDm, participant: { id: USER_B } } },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Factories — constants and wire round-trip
// ---------------------------------------------------------------------------

describe("social factories", () => {
  it("exposes stable SERVER_EVENT name constants", () => {
    expect(SERVER_EVENT.friendRequestReceived).toBe("friend.request_received");
    expect(SERVER_EVENT.friendRequestAccepted).toBe("friend.request_accepted");
    expect(SERVER_EVENT.friendRemoved).toBe("friend.removed");
    expect(SERVER_EVENT.dmCreated).toBe("dm.created");
  });

  it("builds events that survive a JSON wire round-trip and re-validate", () => {
    const event = serverEvent.dmCreated({ dm: sampleDm });
    const decoded = serverToClientEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(decoded).toEqual(event);
  });

  it("tags each factory output with its SERVER_EVENT type", () => {
    expect(
      serverEvent.friendRequestReceived({ request: samplePending, requester: sampleUser }).type,
    ).toBe(SERVER_EVENT.friendRequestReceived);
    expect(
      serverEvent.friendRequestAccepted({ friendship: sampleAccepted, friend: sampleUser }).type,
    ).toBe(SERVER_EVENT.friendRequestAccepted);
    expect(serverEvent.friendRemoved({ userId: USER_B }).type).toBe(SERVER_EVENT.friendRemoved);
    expect(serverEvent.dmCreated({ dm: sampleDm }).type).toBe(SERVER_EVENT.dmCreated);
  });
});
