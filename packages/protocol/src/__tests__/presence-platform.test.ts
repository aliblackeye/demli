import { describe, expect, it } from "vitest";
import type { PresencePayload } from "../events.js";
import { serverEvent } from "../factories.js";
import {
  authSucceededPayloadSchema,
  presencePayloadSchema,
  presencePlatformSchema,
  serverEnvelopeSchema,
  serverToClientEventSchema,
} from "../schemas.js";
import { makeEnvelope } from "../factories.js";

const USER_ID = "44444444-4444-4444-4444-444444444444";

// ---------------------------------------------------------------------------
// The `platform` field on presence — additive + backward compatible (task #47).
// ---------------------------------------------------------------------------

describe("presencePlatformSchema", () => {
  it("accepts the two client kinds", () => {
    expect(presencePlatformSchema.parse("desktop")).toBe("desktop");
    expect(presencePlatformSchema.parse("mobile")).toBe("mobile");
  });

  it("rejects anything else", () => {
    expect(presencePlatformSchema.safeParse("web").success).toBe(false);
    expect(presencePlatformSchema.safeParse("").success).toBe(false);
  });
});

describe("presencePayloadSchema platform field", () => {
  it("is OPTIONAL — a pre-platform payload (no field) still parses", () => {
    const legacy = { userId: USER_ID, status: "online" };
    const parsed = presencePayloadSchema.parse(legacy);
    expect(parsed).toEqual(legacy);
    expect(parsed.platform).toBeUndefined();
  });

  it("carries platform:'mobile' when present", () => {
    const payload: PresencePayload = {
      userId: USER_ID,
      status: "online",
      platform: "mobile",
    };
    expect(presencePayloadSchema.parse(payload)).toEqual(payload);
  });

  it("carries platform:'desktop' when present", () => {
    const payload: PresencePayload = {
      userId: USER_ID,
      status: "idle",
      platform: "desktop",
    };
    expect(presencePayloadSchema.parse(payload)).toEqual(payload);
  });

  it("rejects an invalid platform value", () => {
    const bad = { userId: USER_ID, status: "online", platform: "tablet" };
    expect(presencePayloadSchema.safeParse(bad).success).toBe(false);
  });
});

describe("presence.updated over the wire", () => {
  it("round-trips a mobile presence through the enveloped server event", () => {
    const event = serverEvent.presenceUpdated({
      userId: USER_ID,
      status: "online",
      platform: "mobile",
    });
    const envelope = makeEnvelope(event, 7);
    const decoded = serverEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)));
    expect(decoded.event).toEqual(event);
    if (decoded.event.type === "presence.updated") {
      expect(decoded.event.payload.platform).toBe("mobile");
    }
  });

  it("still validates a presence.updated with no platform (old server)", () => {
    const event = { type: "presence.updated", payload: { userId: USER_ID, status: "offline" } };
    expect(serverToClientEventSchema.safeParse(event).success).toBe(true);
  });
});

describe("auth.succeeded snapshot carries platform per entry", () => {
  it("accepts a mixed snapshot (some entries with platform, some without)", () => {
    const payload = {
      userId: USER_ID,
      presence: [
        { userId: "a", status: "online", platform: "mobile" },
        { userId: "b", status: "idle", platform: "desktop" },
        { userId: "c", status: "offline" },
      ],
    };
    const parsed = authSucceededPayloadSchema.parse(payload);
    expect(parsed.presence[0]?.platform).toBe("mobile");
    expect(parsed.presence[1]?.platform).toBe("desktop");
    expect(parsed.presence[2]?.platform).toBeUndefined();
  });
});
