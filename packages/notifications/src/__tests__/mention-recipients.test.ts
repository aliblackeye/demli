/**
 * Unit tests for the shared @mention recipient resolver. No DB: the only repo
 * method the resolver touches — `channelAccess.canUserSeeChannel` — is stubbed,
 * mirroring the DI/stub style of the push + notifier unit tests. Mentions are
 * built via the protocol encoder so no `<@…>` string is hand-written here.
 */

import { describe, expect, it } from "vitest";
import {
  encodeMention,
  MENTION_EVERYONE,
  MENTION_HERE,
} from "@demli/protocol";
import type { UserId } from "@demli/types";
import {
  MENTION_RECIPIENTS_MAX,
  resolveMentionRecipients,
  mentionPushBody,
  type MentionRecipientRepos,
} from "../mention-recipients.js";

/**
 * Stub repos exposing only `canUserSeeChannel`, recording every id it is asked
 * about so tests can assert the resolver never even checks excluded candidates
 * (broadcast keywords, the author, or ids beyond the cap).
 */
function makeRepos(visible: Iterable<UserId>): {
  repos: MentionRecipientRepos;
  checked: UserId[];
} {
  const visibleSet = new Set(visible);
  const checked: UserId[] = [];
  return {
    checked,
    repos: {
      channelAccess: {
        async canUserSeeChannel(_groupId, channelId, userId) {
          void channelId;
          checked.push(userId);
          return visibleSet.has(userId);
        },
      },
    },
  };
}

const ARGS = { channelId: "c1", groupId: "g1", authorId: "author" } as const;

describe("resolveMentionRecipients", () => {
  it("returns directly-mentioned users who can see the channel", async () => {
    const { repos } = makeRepos(["u2", "u3"]);
    const content = `hey ${encodeMention("u2")} and ${encodeMention("u3")}!`;

    const out = await resolveMentionRecipients({ repos }, { ...ARGS, content });

    expect(out).toEqual(["u2", "u3"]);
  });

  it("excludes broadcast keywords (@everyone / @here) and never checks them", async () => {
    // Even if the visibility set contained them, they must never be resolved.
    const { repos, checked } = makeRepos(["u2", MENTION_EVERYONE, MENTION_HERE]);
    const content = `${encodeMention(MENTION_EVERYONE)} ${encodeMention(
      MENTION_HERE,
    )} ${encodeMention("u2")}`;

    const out = await resolveMentionRecipients({ repos }, { ...ARGS, content });

    expect(out).toEqual(["u2"]);
    expect(checked).toEqual(["u2"]); // broadcast keywords never hit the DB
  });

  it("excludes the author's own id", async () => {
    const { repos, checked } = makeRepos(["author", "u2"]);
    const content = `${encodeMention("author")} pinging ${encodeMention("u2")}`;

    const out = await resolveMentionRecipients({ repos }, { ...ARGS, content });

    expect(out).toEqual(["u2"]);
    expect(checked).toEqual(["u2"]); // author is dropped before the visibility check
  });

  it("drops mentioned users who cannot see the channel (never trusts the sender)", async () => {
    const { repos } = makeRepos(["u2"]); // "stranger" is NOT visible
    const content = `${encodeMention("stranger")} ${encodeMention("u2")}`;

    const out = await resolveMentionRecipients({ repos }, { ...ARGS, content });

    expect(out).toEqual(["u2"]);
  });

  it("dedupes a repeated mention and checks it only once", async () => {
    const { repos, checked } = makeRepos(["u2"]);
    const content = `${encodeMention("u2")} ${encodeMention("u2")} ${encodeMention("u2")}`;

    const out = await resolveMentionRecipients({ repos }, { ...ARGS, content });

    expect(out).toEqual(["u2"]);
    expect(checked).toEqual(["u2"]);
  });

  it("caps the candidate set at MENTION_RECIPIENTS_MAX before any visibility check", async () => {
    const ids = Array.from({ length: MENTION_RECIPIENTS_MAX + 10 }, (_, i) => `u${i}`);
    const { repos, checked } = makeRepos(ids); // all would be visible
    const content = ids.map((id) => encodeMention(id)).join(" ");

    const out = await resolveMentionRecipients({ repos }, { ...ARGS, content });

    expect(out).toHaveLength(MENTION_RECIPIENTS_MAX);
    expect(checked).toHaveLength(MENTION_RECIPIENTS_MAX); // never checks beyond the cap
  });

  it("returns empty and performs no visibility check when there is no mention marker", async () => {
    const { repos, checked } = makeRepos(["u2"]);

    const out = await resolveMentionRecipients(
      { repos },
      { ...ARGS, content: "just a plain message" },
    );

    expect(out).toEqual([]);
    expect(checked).toEqual([]); // fast path: no DB round-trip
  });
});

describe("mentionPushBody", () => {
  it("collapses whitespace and trims", () => {
    expect(mentionPushBody("  hello   there  ")).toBe("hello there");
  });

  it("uses a neutral placeholder for empty / whitespace-only text", () => {
    expect(mentionPushBody("   ")).toBe("Sent an attachment.");
    expect(mentionPushBody("")).toBe("Sent an attachment.");
  });

  it("caps overly long bodies with an ellipsis", () => {
    const body = mentionPushBody("x".repeat(500));
    expect(body).toHaveLength(140);
    expect(body.endsWith("…")).toBe(true);
  });
});
