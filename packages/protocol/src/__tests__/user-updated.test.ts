import { describe, expect, it } from "vitest";
import { SERVER_EVENT, serverEvent } from "../factories.js";
import { serverEnvelopeSchema, serverToClientEventSchema, userUpdatedPayloadSchema } from "../schemas.js";
import type { UserUpdatedPayload } from "../events.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";

/** The public `User` DTO exactly as a profile mutation projects it. */
const publicUser = {
  id: USER_ID,
  username: "ali",
  displayName: "Ali",
  avatarUrl: "https://cdn.example.com/avatars/ali.png",
  bio: "tea enjoyer",
  bannerUrl: "https://cdn.example.com/banners/ali.png",
  createdAt: "2026-07-01T00:00:00.000Z",
};

describe("user.updated event", () => {
  it("exposes the SERVER_EVENT constant (no magic strings, §24)", () => {
    expect(SERVER_EVENT.userUpdated).toBe("user.updated");
  });

  it("factory builds an event that round-trips through the union schema", () => {
    const payload: UserUpdatedPayload = { user: publicUser };
    const event = serverEvent.userUpdated(payload);
    expect(event.type).toBe("user.updated");
    expect(serverToClientEventSchema.parse(event)).toEqual(event);
  });

  it("carries the public profile fields the clients repaint from", () => {
    const parsed = userUpdatedPayloadSchema.parse({ user: publicUser });
    expect(parsed.user.displayName).toBe("Ali");
    expect(parsed.user.avatarUrl).toBe("https://cdn.example.com/avatars/ali.png");
    expect(parsed.user.bannerUrl).toBe("https://cdn.example.com/banners/ali.png");
    expect(parsed.user.bio).toBe("tea enjoyer");
  });

  it("keeps a cleared avatar/banner/bio as an explicit null (not dropped)", () => {
    const parsed = userUpdatedPayloadSchema.parse({
      user: { ...publicUser, avatarUrl: null, bannerUrl: null, bio: null },
    });
    expect(parsed.user.avatarUrl).toBeNull();
    expect(parsed.user.bannerUrl).toBeNull();
    expect(parsed.user.bio).toBeNull();
  });

  // THE security property this event depends on. `user.updated` fans out to every
  // co-member and friend, so an account-private field riding along would leak a
  // user's date of birth / friend code to their whole server. The wire codec must
  // strip them even when a careless caller hands it the full `/users/me` self row.
  it("STRIPS the me-only fields — friendCode, birthdate, isAdult — from the wire", () => {
    const selfRow = {
      ...publicUser,
      friendCode: "ALI-4821",
      birthdate: "1998-04-12",
      isAdult: true,
      email: "ali@example.com",
      passwordHash: "$2b$10$notarealhash",
    };

    const parsed = userUpdatedPayloadSchema.parse({ user: selfRow });

    expect(parsed.user).not.toHaveProperty("friendCode");
    expect(parsed.user).not.toHaveProperty("birthdate");
    expect(parsed.user).not.toHaveProperty("isAdult");
    expect(parsed.user).not.toHaveProperty("email");
    expect(parsed.user).not.toHaveProperty("passwordHash");
    // …and the public fields still survive the strip.
    expect(parsed.user.id).toBe(USER_ID);
    expect(parsed.user.displayName).toBe("Ali");
  });

  it("strips me-only fields through the FULL envelope too (the real send path)", () => {
    const event = serverEvent.userUpdated({
      user: { ...publicUser, friendCode: "ALI-4821", birthdate: "1998-04-12" } as never,
    });
    const parsed = serverEnvelopeSchema.parse({
      event,
      seq: 1,
      sentAt: "2026-07-26T12:00:00.000Z",
    });
    const decoded = parsed.event as Extract<typeof parsed.event, { type: "user.updated" }>;
    expect(decoded.payload.user).not.toHaveProperty("friendCode");
    expect(decoded.payload.user).not.toHaveProperty("birthdate");
  });

  it("rejects a payload with no user, or a user missing its id", () => {
    expect(userUpdatedPayloadSchema.safeParse({}).success).toBe(false);
    const { id: _omitted, ...noId } = publicUser;
    expect(userUpdatedPayloadSchema.safeParse({ user: noId }).success).toBe(false);
  });
});
