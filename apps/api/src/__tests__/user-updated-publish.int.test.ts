/**
 * Every profile mutation must announce itself on the realtime bus — real
 * Postgres, a mock public bucket, a recording mutation bus. Skipped (with a
 * notice) when the database is down.
 *
 * The founder's bug was the ABSENCE of this publish: a profile could change and
 * no other client ever heard about it. These tests pin that each of the three
 * write paths emits exactly one user-scoped `user.updated`, and that the payload
 * is the PUBLIC projection — never the self row.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyMigrations,
  createDb,
  createRepositories,
  type DbClient,
  type RealtimeMutation,
  type RealtimeMutationPublisher,
  type Repositories,
} from "@demli/db";
import { SERVER_EVENT } from "@demli/protocol";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import type { AvatarStorage } from "../lib/storage.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/demli";

async function isDbUp(): Promise<boolean> {
  const { sql, close } = createDb(DATABASE_URL, { max: 1 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await close();
  }
}

class RecordingBus implements RealtimeMutationPublisher {
  published: RealtimeMutation[] = [];
  async publish(mutation: RealtimeMutation): Promise<void> {
    this.published.push(mutation);
  }
  /** Only the `user.updated` mutations, newest last. */
  userUpdates(): RealtimeMutation[] {
    return this.published.filter((m) => m.event.type === SERVER_EVENT.userUpdated);
  }
  reset(): void {
    this.published = [];
  }
}

class MockAvatarStorage implements AvatarStorage {
  async upload(): Promise<void> {}
  async remove(): Promise<void> {}
  publicUrl(path: string): string {
    return `https://cdn.example/avatars-bucket/${path}`;
  }
}

/**
 * A REAL minimal PNG header — signature plus an IHDR that states 8×8.
 *
 * The dimensions matter: the banner path runs a decompression-bomb guard that
 * refuses any image whose header will not state its own size, so a
 * signature-plus-zeroes stub (what this used to be) is correctly rejected as
 * unreadable. `avatarBase64` keeps the old stub shape because the avatar route
 * does not run that guard.
 */
function pngBase64(bytes = 128): string {
  const buf = Buffer.alloc(bytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
  buf.writeUInt32BE(13, 8); // IHDR chunk length
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(8, 16); // width
  buf.writeUInt32BE(8, 20); // height
  return buf.toString("base64");
}

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[user-updated-publish.int.test] DATABASE unreachable — skipping");
}

describe.skipIf(!dbUp)("profile mutations publish user.updated", () => {
  let client: DbClient;
  let repos: Repositories;
  let app: FastifyInstance;
  let bus: RecordingBus;

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  let token: string;
  let userId: string;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    bus = new RecordingBus();
    app = await buildApp({
      repos,
      env: loadEnv({ DATABASE_URL }),
      avatarStorage: new MockAvatarStorage(),
      mutationBus: bus,
      logger: false,
    });

    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username: `pub_${suffix}`, password: "correct-horse-9", displayName: "Pub" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { token: string; user: { id: string } };
    token = body.token;
    userId = body.user.id;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("PATCH /users/me publishes one user-scoped user.updated with the new values", async () => {
    bus.reset();
    const res = await app.inject({
      method: "PATCH",
      url: "/users/me",
      headers: auth(token),
      payload: { displayName: "Renamed", bio: "new bio" },
    });
    expect(res.statusCode).toBe(200);

    const updates = bus.userUpdates();
    expect(updates).toHaveLength(1);
    const mutation = updates[0]!;
    // USER-scoped: the gateway keys the audience expansion off this id.
    expect(mutation.userId).toBe(userId);
    expect(mutation.channelId).toBeUndefined();
    expect(mutation.groupId).toBeUndefined();

    const event = mutation.event as Extract<
      typeof mutation.event,
      { type: "user.updated" }
    >;
    expect(event.payload.user.id).toBe(userId);
    expect(event.payload.user.displayName).toBe("Renamed");
    expect(event.payload.user.bio).toBe("new bio");
  });

  it("publishes the PUBLIC projection — no friendCode/birthdate on the event", async () => {
    bus.reset();
    // Set the birthdate (set-once) so the self row definitely carries one.
    const res = await app.inject({
      method: "PATCH",
      url: "/users/me",
      headers: auth(token),
      payload: { birthdate: "1998-04-12" },
    });
    expect(res.statusCode).toBe(200);
    // The RESPONSE is the self row and legitimately carries the private fields…
    expect((res.json().user as { friendCode?: string }).friendCode).toBeTruthy();

    // …but the broadcast payload must not.
    const event = bus.userUpdates()[0]!.event as Extract<
      ReturnType<() => RealtimeMutation["event"]>,
      { type: "user.updated" }
    >;
    expect(event.payload.user).not.toHaveProperty("friendCode");
    expect(event.payload.user).not.toHaveProperty("birthdate");
    expect(event.payload.user).not.toHaveProperty("isAdult");
  });

  it("POST /users/me/avatar publishes user.updated carrying the new avatar url", async () => {
    bus.reset();
    const res = await app.inject({
      method: "POST",
      url: "/users/me/avatar",
      headers: auth(token),
      payload: { mime: "image/png", dataBase64: pngBase64() },
    });
    expect(res.statusCode).toBe(200);

    const updates = bus.userUpdates();
    expect(updates).toHaveLength(1);
    const event = updates[0]!.event as Extract<
      RealtimeMutation["event"],
      { type: "user.updated" }
    >;
    expect(updates[0]!.userId).toBe(userId);
    expect(event.payload.user.avatarUrl).toMatch(
      /^https:\/\/cdn\.example\/avatars-bucket\/avatars\//,
    );
  });

  it("POST /users/me/banner publishes user.updated carrying the new banner url", async () => {
    bus.reset();
    const res = await app.inject({
      method: "POST",
      url: "/users/me/banner",
      headers: auth(token),
      payload: { mime: "image/png", dataBase64: pngBase64() },
    });
    expect(res.statusCode).toBe(200);

    const updates = bus.userUpdates();
    expect(updates).toHaveLength(1);
    const event = updates[0]!.event as Extract<
      RealtimeMutation["event"],
      { type: "user.updated" }
    >;
    expect(event.payload.user.bannerUrl).toMatch(
      /^https:\/\/cdn\.example\/avatars-bucket\/banners\//,
    );
  });

  it("does not publish when the write is rejected (locked birthdate)", async () => {
    bus.reset();
    // The birthdate was already set above — a second attempt must 409 AND stay silent.
    const res = await app.inject({
      method: "PATCH",
      url: "/users/me",
      headers: auth(token),
      payload: { birthdate: "2001-01-01" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe("BIRTHDATE_LOCKED");
    expect(bus.userUpdates()).toHaveLength(0);
  });
});
