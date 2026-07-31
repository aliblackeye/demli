/**
 * The sidebar renders the server's answer — it does not decide who sees what.
 *
 * Channel VISIBILITY is server-owned (ADR 0007): `GET /groups/:id` returns only
 * the channels the caller may see, and a restricted channel they lack the role
 * for is absent from the payload entirely (its existence is not leaked). So the
 * client's whole job is to render what it was handed, exactly.
 *
 * That matters more since M20 gave voice channels a text chat, because it is
 * now tempting to "help" — to drop voice channels from a chat-shaped list, or to
 * synthesise a row for a channel the user cannot see so a mention resolves. Both
 * would put the access decision in two places, and the client's copy would be
 * the wrong one. These lock the pass-through: no channel added, none dropped, no
 * kind filter anywhere in the placement model.
 */

import { describe, expect, it } from "vitest";
import type { Channel, ChannelCategory } from "@demli/types";
import { buildSidebarBuckets } from "./channelOrder";

const GROUP = "grp-1";

function ch(
  id: string,
  position: number,
  categoryId: string | null = null,
  kind: Channel["kind"] = "text",
): Channel {
  return {
    id,
    groupId: GROUP,
    kind,
    name: id,
    position,
    createdAt: "2026-01-01T00:00:00.000Z",
    categoryId,
  };
}

function cat(id: string, position: number): ChannelCategory {
  return {
    id,
    groupId: GROUP,
    name: id.toUpperCase(),
    position,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const idsOf = (buckets: ReturnType<typeof buildSidebarBuckets>): string[] =>
  buckets.flatMap((b) => b.channels.map((c) => c.id));

describe("the channel list is exactly what the server sent", () => {
  it("places voice channels alongside text ones, never filtering a kind out", () => {
    const buckets = buildSidebarBuckets(
      [ch("general", 0), ch("lobby", 1, null, "voice"), ch("random", 2)],
      [],
    );
    expect(idsOf(buckets)).toEqual(["general", "lobby", "random"]);
  });

  it("keeps voice channels filed under their category", () => {
    const buckets = buildSidebarBuckets(
      [ch("general", 0, "c1"), ch("lobby", 1, "c1", "voice"), ch("afk", 0, null, "voice")],
      [cat("c1", 0)],
    );
    expect(idsOf(buckets).sort()).toEqual(["afk", "general", "lobby"]);
  });

  it("shows nothing for a viewer whose payload omits the restricted channel", () => {
    // This is what an invisible channel looks like on the client: absent. The
    // model must not resurrect it, and must not leave a placeholder behind.
    const visibleOnly = [ch("general", 0), ch("lobby", 1, null, "voice")];
    const buckets = buildSidebarBuckets(visibleOnly, []);
    expect(idsOf(buckets)).toEqual(["general", "lobby"]);
    expect(idsOf(buckets)).not.toContain("staff-only");
  });

  it("renders an empty server as empty rather than inventing a default channel", () => {
    expect(idsOf(buildSidebarBuckets([], []))).toEqual([]);
  });
});
