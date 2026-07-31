/**
 * M10 media-attachment repo-level integration tests — real Postgres.
 * Skipped automatically (with a console notice) when the database is down.
 *
 * Covers migration 0006 + attachmentsRepo:
 * - createPending → markReady → attachToMessage lifecycle
 * - markReady owner/status guards + idempotent retry
 * - attachToMessage rejections (unknown / foreign / not-ready / already-linked),
 *   atomicity, and same-message idempotent re-link
 * - listForMessages bulk grouping (no N+1)
 * - hard-delete cascade from messages, channel cascade of orphan uploads
 * - deleteForMessage returns storage paths for purge
 * - deleteUnlinkedById removes an unlinked/owned row (returns path) and refuses
 *   a foreign uploader / already-linked / unknown id
 * - sweepStalePending selects only stale UNLINKED rows
 * - storage_path uniqueness
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  AttachmentLinkError,
  createDb,
  createRepositories,
  schema,
  type DbClient,
  type Repositories,
} from "../index.js";
import { refuseToSkipIfRequired } from "../testing.js";

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

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[attachments.int.test] DATABASE unreachable — skipping");
}

/**
 * Per-file random tag. Test files run in parallel workers against ONE shared
 * Postgres, so a fixture id must be unique across files, not just within one.
 * `Date.now()` + a small counter is NOT enough — two files can mint the same
 * millisecond and counter value and collide on `users_username_unique`. This
 * UUID tag gives every username/storage-path in this file its own namespace.
 */
const RUN = randomUUID().slice(0, 8);

describe.skipIf(!dbUp)("m10 media attachments (repo level)", () => {
  let client: DbClient;
  let repos: Repositories;
  let uniq = 0;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
  });

  afterAll(async () => {
    await client?.close();
  });

  function nextSuffix(): string {
    uniq += 1;
    return `${RUN}${uniq.toString(36)}`;
  }

  async function makeUser(label: string): Promise<string> {
    const u = await repos.users.create({
      username: `${label}_${nextSuffix()}`,
      displayName: label,
      passwordHash: "not-used",
    });
    return u.id;
  }

  /** A fresh server + text channel; returns owner/group/channel ids. */
  async function makeChannel(): Promise<{
    ownerId: string;
    groupId: string;
    channelId: string;
  }> {
    const ownerId = await makeUser("owner");
    const group = await repos.groups.create({ name: "Att Test", ownerId });
    const channel = await repos.channels.create({
      groupId: group.id,
      kind: "text",
      name: "general",
    });
    return { ownerId, groupId: group.id, channelId: channel.id };
  }

  async function makePending(channelId: string, uploaderId: string) {
    return repos.attachments.createPending({
      channelId,
      uploaderId,
      kind: "image",
      mime: "image/png",
      sizeBytes: 1234,
      width: 800,
      height: 600,
      storagePath: `attachments/${channelId}/${nextSuffix()}.png`,
    });
  }

  async function makeReady(channelId: string, uploaderId: string) {
    const pending = await makePending(channelId, uploaderId);
    const ready = await repos.attachments.markReady(pending.id, { uploaderId });
    if (!ready) throw new Error("makeReady: markReady returned null");
    return ready;
  }

  async function makeMessage(channelId: string, authorId: string) {
    return repos.messages.create({ channelId, authorId, content: "with a file" });
  }

  // ---- lifecycle ------------------------------------------------------------

  it("walks createPending → markReady → attachToMessage", async () => {
    const { channelId, ownerId } = await makeChannel();

    const pending = await makePending(channelId, ownerId);
    expect(pending.status).toBe("pending");
    expect(pending.messageId).toBeNull();
    expect(await repos.attachments.findById(pending.id)).not.toBeNull();

    const ready = await repos.attachments.markReady(pending.id, {
      uploaderId: ownerId,
      width: 1920,
      height: 1080,
    });
    expect(ready?.status).toBe("ready");
    expect(ready?.messageId).toBeNull();
    expect(ready?.width).toBe(1920);
    expect(ready?.height).toBe(1080);

    const msg = await makeMessage(channelId, ownerId);
    const linked = await repos.attachments.attachToMessage([pending.id], msg.id, ownerId);
    expect(linked).toHaveLength(1);
    expect(linked[0]?.messageId).toBe(msg.id);

    const onMsg = await repos.attachments.listForMessage(msg.id);
    expect(onMsg.map((a) => a.id)).toEqual([pending.id]);
  });

  // ---- markReady guards -----------------------------------------------------

  it("markReady rejects a foreign uploader and is idempotent on retry", async () => {
    const { channelId, ownerId } = await makeChannel();
    const other = await makeUser("other");
    const pending = await makePending(channelId, ownerId);

    // Foreign uploader cannot complete someone else's upload.
    expect(await repos.attachments.markReady(pending.id, { uploaderId: other })).toBeNull();
    expect((await repos.attachments.findById(pending.id))?.status).toBe("pending");

    const first = await repos.attachments.markReady(pending.id, { uploaderId: ownerId });
    const second = await repos.attachments.markReady(pending.id, { uploaderId: ownerId });
    expect(first?.status).toBe("ready");
    expect(second?.id).toBe(first?.id); // retried complete → same ready row
  });

  it("markReady on an already-linked attachment returns null", async () => {
    const { channelId, ownerId } = await makeChannel();
    const ready = await makeReady(channelId, ownerId);
    const msg = await makeMessage(channelId, ownerId);
    await repos.attachments.attachToMessage([ready.id], msg.id, ownerId);

    expect(await repos.attachments.markReady(ready.id, { uploaderId: ownerId })).toBeNull();
  });

  // ---- attachToMessage guards ----------------------------------------------

  it("attachToMessage rejects unknown / foreign / not-ready / already-linked ids", async () => {
    const { channelId, ownerId } = await makeChannel();
    const other = await makeUser("intruder");
    const msg = await makeMessage(channelId, ownerId);

    // unknown id
    await expect(
      repos.attachments.attachToMessage(
        ["00000000-0000-0000-0000-000000000000"],
        msg.id,
        ownerId,
      ),
    ).rejects.toBeInstanceOf(AttachmentLinkError);

    // foreign uploader
    const foreign = await makeReady(channelId, other);
    await expect(
      repos.attachments.attachToMessage([foreign.id], msg.id, ownerId),
    ).rejects.toMatchObject({ reason: "foreign_uploader" });

    // not ready (still pending)
    const pending = await makePending(channelId, ownerId);
    await expect(
      repos.attachments.attachToMessage([pending.id], msg.id, ownerId),
    ).rejects.toMatchObject({ reason: "not_ready" });

    // already linked to a DIFFERENT message
    const ready = await makeReady(channelId, ownerId);
    const otherMsg = await makeMessage(channelId, ownerId);
    await repos.attachments.attachToMessage([ready.id], otherMsg.id, ownerId);
    await expect(
      repos.attachments.attachToMessage([ready.id], msg.id, ownerId),
    ).rejects.toMatchObject({ reason: "already_linked" });
  });

  it("attachToMessage is atomic — a bad id links none of the batch", async () => {
    const { channelId, ownerId } = await makeChannel();
    const good = await makeReady(channelId, ownerId);
    const pending = await makePending(channelId, ownerId); // not ready → whole batch fails
    const msg = await makeMessage(channelId, ownerId);

    await expect(
      repos.attachments.attachToMessage([good.id, pending.id], msg.id, ownerId),
    ).rejects.toBeInstanceOf(AttachmentLinkError);

    // The good attachment must remain unlinked.
    expect((await repos.attachments.findById(good.id))?.messageId).toBeNull();
    expect(await repos.attachments.listForMessage(msg.id)).toEqual([]);
  });

  it("attachToMessage is idempotent for a retried send (same ids, same message)", async () => {
    const { channelId, ownerId } = await makeChannel();
    const a = await makeReady(channelId, ownerId);
    const b = await makeReady(channelId, ownerId);
    const msg = await makeMessage(channelId, ownerId);

    const first = await repos.attachments.attachToMessage([a.id, b.id], msg.id, ownerId);
    const retry = await repos.attachments.attachToMessage([a.id, b.id], msg.id, ownerId);

    expect(first).toHaveLength(2);
    expect(retry.map((x) => x.id).sort()).toEqual(first.map((x) => x.id).sort());
    expect(await repos.attachments.listForMessage(msg.id)).toHaveLength(2);
  });

  // ---- bulk listing ---------------------------------------------------------

  it("listForMessages groups by message id in one query (no N+1)", async () => {
    const { channelId, ownerId } = await makeChannel();
    const m1 = await makeMessage(channelId, ownerId);
    const m2 = await makeMessage(channelId, ownerId);
    const m3 = await makeMessage(channelId, ownerId); // no attachments

    const a1 = await makeReady(channelId, ownerId);
    const a2 = await makeReady(channelId, ownerId);
    const a3 = await makeReady(channelId, ownerId);
    await repos.attachments.attachToMessage([a1.id, a2.id], m1.id, ownerId);
    await repos.attachments.attachToMessage([a3.id], m2.id, ownerId);

    const grouped = await repos.attachments.listForMessages([m1.id, m2.id, m3.id]);
    expect(grouped.get(m1.id)?.map((a) => a.id).sort()).toEqual([a1.id, a2.id].sort());
    expect(grouped.get(m2.id)?.map((a) => a.id)).toEqual([a3.id]);
    expect(grouped.has(m3.id)).toBe(false); // absent, caller reads `?? []`
  });

  // ---- cascades + delete ----------------------------------------------------

  it("hard-deleting a message cascades its attachment rows", async () => {
    const { channelId, ownerId } = await makeChannel();
    const ready = await makeReady(channelId, ownerId);
    const msg = await makeMessage(channelId, ownerId);
    await repos.attachments.attachToMessage([ready.id], msg.id, ownerId);

    await client.db.delete(schema.messages).where(eq(schema.messages.id, msg.id));

    expect(await repos.attachments.findById(ready.id)).toBeNull();
  });

  it("deleting a channel cascades still-unlinked (orphan) uploads", async () => {
    const { channelId, ownerId } = await makeChannel();
    const orphan = await makePending(channelId, ownerId); // never linked

    await client.db.delete(schema.channels).where(eq(schema.channels.id, channelId));

    expect(await repos.attachments.findById(orphan.id)).toBeNull();
  });

  it("deleteForMessage removes rows and returns storage paths to purge", async () => {
    const { channelId, ownerId } = await makeChannel();
    const a = await makeReady(channelId, ownerId);
    const b = await makeReady(channelId, ownerId);
    const msg = await makeMessage(channelId, ownerId);
    await repos.attachments.attachToMessage([a.id, b.id], msg.id, ownerId);

    const deleted = await repos.attachments.deleteForMessage(msg.id);
    expect(deleted).toHaveLength(2);
    expect(deleted.every((d) => typeof d.storagePath === "string" && d.storagePath.length > 0)).toBe(
      true,
    );
    expect(await repos.attachments.listForMessage(msg.id)).toEqual([]);
  });

  it("deleteUnlinkedById removes an unlinked row and returns its storage path", async () => {
    const { channelId, ownerId } = await makeChannel();

    // A never-completed pending upload is deletable and returns its path.
    const pending = await makePending(channelId, ownerId);
    const deletedPending = await repos.attachments.deleteUnlinkedById(pending.id, ownerId);
    expect(deletedPending?.id).toBe(pending.id);
    expect(deletedPending?.storagePath).toBe(pending.storagePath);
    expect(await repos.attachments.findById(pending.id)).toBeNull();

    // A completed-but-unsent ready upload is deletable too.
    const ready = await makeReady(channelId, ownerId);
    const deletedReady = await repos.attachments.deleteUnlinkedById(ready.id, ownerId);
    expect(deletedReady?.id).toBe(ready.id);
    expect(await repos.attachments.findById(ready.id)).toBeNull();
  });

  it("deleteUnlinkedById refuses a foreign uploader, a linked row, and an unknown id", async () => {
    const { channelId, ownerId } = await makeChannel();
    const other = await makeUser("thief");

    // Foreign uploader → null, and the row survives.
    const owned = await makeReady(channelId, ownerId);
    expect(await repos.attachments.deleteUnlinkedById(owned.id, other)).toBeNull();
    expect(await repos.attachments.findById(owned.id)).not.toBeNull();

    // Already linked to a message → null (guarded by message_id IS NULL); survives.
    const linked = await makeReady(channelId, ownerId);
    const msg = await makeMessage(channelId, ownerId);
    await repos.attachments.attachToMessage([linked.id], msg.id, ownerId);
    expect(await repos.attachments.deleteUnlinkedById(linked.id, ownerId)).toBeNull();
    expect(await repos.attachments.findById(linked.id)).not.toBeNull();

    // Unknown id → null.
    expect(
      await repos.attachments.deleteUnlinkedById(
        "00000000-0000-0000-0000-000000000000",
        ownerId,
      ),
    ).toBeNull();
  });

  // ---- sweep ----------------------------------------------------------------

  it("sweepStalePending deletes only stale UNLINKED rows", async () => {
    const { channelId, ownerId } = await makeChannel();

    const stalePending = await makePending(channelId, ownerId);
    const staleReady = await makeReady(channelId, ownerId);
    const freshPending = await makePending(channelId, ownerId);
    const linked = await makeReady(channelId, ownerId);
    const msg = await makeMessage(channelId, ownerId);
    await repos.attachments.attachToMessage([linked.id], msg.id, ownerId);

    // Backdate the two orphans well past the 24h cutoff.
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await client.db
      .update(schema.attachments)
      .set({ createdAt: old })
      .where(eq(schema.attachments.id, stalePending.id));
    await client.db
      .update(schema.attachments)
      .set({ createdAt: old })
      .where(eq(schema.attachments.id, staleReady.id));

    const swept = await repos.attachments.sweepStalePending(24);
    const sweptIds = swept.map((s) => s.id);

    // Both stale unlinked rows (pending AND ready) are reaped…
    expect(sweptIds).toContain(stalePending.id);
    expect(sweptIds).toContain(staleReady.id);
    // …the fresh orphan and the linked row are not.
    expect(sweptIds).not.toContain(freshPending.id);
    expect(sweptIds).not.toContain(linked.id);
    expect(await repos.attachments.findById(freshPending.id)).not.toBeNull();
    expect(await repos.attachments.findById(linked.id)).not.toBeNull();
    expect(await repos.attachments.findById(stalePending.id)).toBeNull();
  });

  // ---- constraints ----------------------------------------------------------

  it("storage_path is unique across attachments", async () => {
    const { channelId, ownerId } = await makeChannel();
    const path = `attachments/${channelId}/dupe-${nextSuffix()}.png`;
    await repos.attachments.createPending({
      channelId,
      uploaderId: ownerId,
      kind: "image",
      mime: "image/png",
      sizeBytes: 10,
      storagePath: path,
    });
    await expect(
      repos.attachments.createPending({
        channelId,
        uploaderId: ownerId,
        kind: "image",
        mime: "image/png",
        sizeBytes: 10,
        storagePath: path,
      }),
    ).rejects.toThrow();
  });
});
