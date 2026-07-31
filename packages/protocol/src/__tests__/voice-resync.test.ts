import { describe, expect, it } from "vitest";
import type { VoiceOccupancySnapshot } from "../events.js";
import { makeEnvelope, serverEvent, SERVER_EVENT } from "../factories.js";
import {
  serverEnvelopeSchema,
  serverToClientEventSchema,
  voiceChannelOccupantsSchema,
  voiceOccupancySnapshotSchema,
  voiceOccupantSchema,
} from "../schemas.js";

// ---------------------------------------------------------------------------
// STATE RESYNC — the authoritative voice occupancy snapshot (screen-share fix).
// `voice.resync` carries the media-plane truth so a missed join/leave/screen
// delta self-heals on every (re)connect. Additive + backward compatible: the
// occupant's screen-share/camera fields are optional, so the in-memory
// `auth.succeeded` snapshot (which omits them) still validates unchanged.
// ---------------------------------------------------------------------------

const CH = "11111111-1111-4111-8111-111111111111";
const CH2 = "22222222-2222-4222-8222-222222222222";
const UID = "33333333-3333-4333-8333-333333333333";
const UID2 = "44444444-4444-4444-8444-444444444444";

describe("voiceOccupantSchema screen-share/camera fields", () => {
  it("accepts an occupant WITHOUT the new fields (in-memory snapshot / delta)", () => {
    const legacy = { userId: UID, muted: false };
    const parsed = voiceOccupantSchema.parse(legacy);
    expect(parsed).toEqual(legacy);
    expect(parsed.screenSharing).toBeUndefined();
    expect(parsed.camera).toBeUndefined();
  });

  it("carries authoritative screenSharing/camera when present", () => {
    const occ = { userId: UID, muted: true, screenSharing: true, camera: false };
    expect(voiceOccupantSchema.parse(occ)).toEqual(occ);
  });

  it("rejects a non-boolean screenSharing", () => {
    const bad = { userId: UID, muted: false, screenSharing: "yes" };
    expect(voiceOccupantSchema.safeParse(bad).success).toBe(false);
  });
});

describe("voiceOccupancySnapshotSchema", () => {
  it("accepts an empty snapshot (nobody visible is in voice)", () => {
    expect(voiceOccupancySnapshotSchema.parse({ channels: [] })).toEqual({ channels: [] });
  });

  it("accepts a multi-channel snapshot with mixed screen-share state", () => {
    const snapshot: VoiceOccupancySnapshot = {
      channels: [
        {
          channelId: CH,
          occupants: [
            { userId: UID, muted: false, screenSharing: true, camera: false },
            { userId: UID2, muted: true, screenSharing: false, camera: true },
          ],
        },
        { channelId: CH2, occupants: [{ userId: UID, muted: false, screenSharing: false }] },
      ],
    };
    expect(voiceOccupancySnapshotSchema.parse(snapshot)).toEqual(snapshot);
    // The nested per-channel shape stays reusable on its own.
    expect(voiceChannelOccupantsSchema.parse(snapshot.channels[0]).occupants).toHaveLength(2);
  });
});

describe("voice.resync over the wire", () => {
  it("round-trips through the enveloped server event", () => {
    const event = serverEvent.voiceResync({
      channels: [
        { channelId: CH, occupants: [{ userId: UID, muted: false, screenSharing: true, camera: false }] },
      ],
    });
    expect(event.type).toBe(SERVER_EVENT.voiceResync);

    const envelope = makeEnvelope(event, 12);
    const decoded = serverEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)));
    expect(decoded.event).toEqual(event);
    if (decoded.event.type === SERVER_EVENT.voiceResync) {
      expect(decoded.event.payload.channels[0]?.occupants[0]?.screenSharing).toBe(true);
    }
  });

  it("is a recognized member of the server→client union", () => {
    const event = { type: "voice.resync", payload: { channels: [] } };
    expect(serverToClientEventSchema.safeParse(event).success).toBe(true);
  });
});
