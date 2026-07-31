/**
 * #110 — the `presence.app_state` client→server event (WhatsApp-style push gate).
 * The client reports foreground/background so the gateway records it per
 * connection; the value drives OS-push suppression, never presence display.
 */

import { describe, expect, it } from "vitest";
import { clientEvent, CLIENT_EVENT } from "../factories.js";
import { appLifecycleStateSchema, appStatePayloadSchema, clientToServerEventSchema } from "../schemas.js";

describe("appLifecycleStateSchema", () => {
  it("accepts the two lifecycle states", () => {
    expect(appLifecycleStateSchema.parse("foreground")).toBe("foreground");
    expect(appLifecycleStateSchema.parse("background")).toBe("background");
  });

  it("rejects anything else (closed enum)", () => {
    expect(appLifecycleStateSchema.safeParse("active").success).toBe(false);
    expect(appLifecycleStateSchema.safeParse("").success).toBe(false);
    expect(appLifecycleStateSchema.safeParse(undefined).success).toBe(false);
  });
});

describe("appStatePayloadSchema", () => {
  it("requires the state field", () => {
    expect(appStatePayloadSchema.safeParse({}).success).toBe(false);
    expect(appStatePayloadSchema.parse({ state: "background" })).toEqual({ state: "background" });
  });

  it("carries no client-supplied identity (userId/connectionId are stripped)", () => {
    // The gateway uses the authenticated socket's own id — a client cannot spoof
    // whose app state this is. zod strips unknown keys, so any smuggled id is gone.
    const parsed = appStatePayloadSchema.parse({
      state: "foreground",
      userId: "someone-else",
      connectionId: "spoofed",
    });
    expect(parsed).toEqual({ state: "foreground" });
  });
});

describe("presence.app_state on the client→server union", () => {
  it("is a member of the discriminated union with a valid payload", () => {
    const event = clientEvent.presenceAppState({ state: "background" });
    expect(event.type).toBe("presence.app_state");
    expect(event.type).toBe(CLIENT_EVENT.presenceAppState);
    const parsed = clientToServerEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "presence.app_state") {
      expect(parsed.data.payload.state).toBe("background");
    }
  });

  it("rejects an invalid state value at the boundary", () => {
    const bad = { type: "presence.app_state", payload: { state: "asleep" } };
    expect(clientToServerEventSchema.safeParse(bad).success).toBe(false);
  });

  it("round-trips through JSON (the wire form the gateway parses)", () => {
    const event = clientEvent.presenceAppState({ state: "foreground" });
    const decoded = clientToServerEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(decoded).toEqual(event);
  });
});
