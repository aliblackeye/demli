import { describe, expect, it } from "vitest";
import type { FriendGroup } from "@demli/types";
import { SERVER_EVENT, serverEvent } from "../factories.js";
import { friendGroupSchema, serverToClientEventSchema } from "../schemas.js";

const GROUP_ID = "11111111-1111-1111-1111-111111111111";
const OWNER_ID = "44444444-4444-4444-4444-444444444444";
const CHANNEL_ID = "22222222-2222-2222-2222-222222222222";

const sampleServer: FriendGroup = {
  id: GROUP_ID,
  name: "Film Night",
  iconUrl: null,
  ownerId: OWNER_ID,
  kind: "server",
  systemChannelId: CHANNEL_ID,
  invitePolicy: "members",
  createdAt: "2026-07-14T10:00:00.000Z",
};

// ---------------------------------------------------------------------------
// DTO schema
// ---------------------------------------------------------------------------

describe("friendGroupSchema", () => {
  it("accepts a full server group", () => {
    expect(friendGroupSchema.parse(sampleServer)).toEqual(sampleServer);
  });

  it("accepts a minimal flat group chat (server-only meta omitted)", () => {
    const groupChat: FriendGroup = {
      id: GROUP_ID,
      name: "trip",
      iconUrl: null,
      ownerId: OWNER_ID,
      kind: "group",
      createdAt: "2026-07-14T10:00:00.000Z",
    };
    expect(friendGroupSchema.safeParse(groupChat).success).toBe(true);
  });

  it("accepts a dm-kind group (the schema mirrors every FriendGroupKind)", () => {
    expect(friendGroupSchema.safeParse({ ...sampleServer, kind: "dm" }).success).toBe(true);
  });

  it("rejects an unknown group kind", () => {
    expect(friendGroupSchema.safeParse({ ...sampleServer, kind: "workspace" }).success).toBe(
      false,
    );
  });

  it("rejects a missing ownerId", () => {
    const { ownerId: _drop, ...rest } = sampleServer;
    expect(friendGroupSchema.safeParse(rest).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Server event schemas — acceptance
// ---------------------------------------------------------------------------

describe("group lifecycle server events — schema acceptance", () => {
  it("accepts group.updated carrying a full group", () => {
    const result = serverToClientEventSchema.safeParse(
      serverEvent.groupUpdated({ group: { ...sampleServer, name: "Renamed" } }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts group.deleted carrying only the group id", () => {
    const result = serverToClientEventSchema.safeParse(
      serverEvent.groupDeleted({ groupId: GROUP_ID }),
    );
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Server event schemas — rejection
// ---------------------------------------------------------------------------

describe("group lifecycle server events — schema rejection", () => {
  it("rejects group.updated carrying a malformed group", () => {
    const result = serverToClientEventSchema.safeParse({
      type: "group.updated",
      payload: { group: { ...sampleServer, ownerId: 123 } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects group.deleted missing the group-scope groupId", () => {
    const result = serverToClientEventSchema.safeParse({
      type: "group.deleted",
      payload: {},
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Factories — constants and wire round-trip
// ---------------------------------------------------------------------------

describe("group lifecycle factories", () => {
  it("exposes stable SERVER_EVENT name constants", () => {
    expect(SERVER_EVENT.groupUpdated).toBe("group.updated");
    expect(SERVER_EVENT.groupDeleted).toBe("group.deleted");
  });

  it("builds events that survive a JSON wire round-trip and re-validate", () => {
    const event = serverEvent.groupUpdated({ group: sampleServer });
    const decoded = serverToClientEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(decoded).toEqual(event);
  });

  it("tags each factory output with its SERVER_EVENT type", () => {
    expect(serverEvent.groupUpdated({ group: sampleServer }).type).toBe(SERVER_EVENT.groupUpdated);
    expect(serverEvent.groupDeleted({ groupId: GROUP_ID }).type).toBe(SERVER_EVENT.groupDeleted);
  });
});

// ---------------------------------------------------------------------------
// group_chat.added — the user-scoped "you were added to a flat group chat" event
// (the group-chat twin of dm.created).
// ---------------------------------------------------------------------------

const sampleGroupChat = {
  id: GROUP_ID,
  name: "weekly",
  iconUrl: null,
  ownerId: OWNER_ID,
  streamId: CHANNEL_ID,
  createdAt: "2026-07-24T10:00:00.000Z",
};

describe("group_chat.added", () => {
  it("exposes a stable SERVER_EVENT name constant", () => {
    expect(SERVER_EVENT.groupChatAdded).toBe("group_chat.added");
  });

  it("accepts a well-formed event carrying the flat-chat group projection", () => {
    const result = serverToClientEventSchema.safeParse(
      serverEvent.groupChatAdded({ group: sampleGroupChat }),
    );
    expect(result.success).toBe(true);
  });

  it("survives a JSON wire round-trip and re-validates", () => {
    const event = serverEvent.groupChatAdded({ group: sampleGroupChat });
    const decoded = serverToClientEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(decoded).toEqual(event);
  });

  it("rejects a payload whose group is missing the streamId (needed to subscribe)", () => {
    const { streamId: _drop, ...noStream } = sampleGroupChat;
    const result = serverToClientEventSchema.safeParse({
      type: "group_chat.added",
      payload: { group: noStream },
    });
    expect(result.success).toBe(false);
  });
});
