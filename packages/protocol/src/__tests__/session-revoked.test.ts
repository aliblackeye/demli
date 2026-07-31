import { describe, expect, it } from "vitest";
import { SERVER_EVENT, serverEvent } from "../factories.js";
import {
  sessionRevokedPayloadSchema,
  serverToClientEventSchema,
} from "../schemas.js";
import type { SessionRevokedPayload } from "../events.js";

const SESSION_A = "11111111-1111-1111-1111-111111111111";
const SESSION_B = "22222222-2222-2222-2222-222222222222";

describe("session.revoked event (#98)", () => {
  it("exposes the SERVER_EVENT constant (no magic strings, §24)", () => {
    expect(SERVER_EVENT.sessionRevoked).toBe("session.revoked");
  });

  it("factory builds a single-session revoke that round-trips through the schema", () => {
    const payload: SessionRevokedPayload = { sessionIds: [SESSION_A] };
    const event = serverEvent.sessionRevoked(payload);
    expect(event.type).toBe("session.revoked");

    const parsed = serverToClientEventSchema.parse(event);
    expect(parsed).toEqual(event);
  });

  it("carries multiple ids intact ('sign out everywhere else')", () => {
    const payload: SessionRevokedPayload = { sessionIds: [SESSION_A, SESSION_B] };
    const event = serverEvent.sessionRevoked(payload);
    expect(serverToClientEventSchema.parse(event)).toEqual(event);
    expect(sessionRevokedPayloadSchema.parse(payload).sessionIds).toEqual([
      SESSION_A,
      SESSION_B,
    ]);
  });

  it("rejects an empty list — the publishers only emit ≥1 revoked id", () => {
    expect(sessionRevokedPayloadSchema.safeParse({ sessionIds: [] }).success).toBe(false);
  });

  it("rejects a non-string id and a missing sessionIds field", () => {
    expect(sessionRevokedPayloadSchema.safeParse({ sessionIds: [42] }).success).toBe(false);
    expect(sessionRevokedPayloadSchema.safeParse({}).success).toBe(false);
  });
});
