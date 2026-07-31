/**
 * The mention-insert seam (user menu → open composer).
 *
 * It is a module-level emitter rather than store state on purpose, and the two
 * properties that makes it safe are exactly what is asserted here: an unmounted
 * composer must not keep receiving inserts (a leak would type into a screen the
 * user left), and a publish with nobody listening must be a silent no-op rather
 * than a throw — the sheet can be open on a screen that has no composer at all.
 */

import { describe, expect, it, vi } from "vitest";
import {
  applyMentionInsert,
  serializeMentions,
  type PendingMention,
} from "@demli/client-core";
import { onMentionInsert, requestMentionInsert } from "../mention-insert";

describe("mention insert seam", () => {
  it("delivers the request to a subscribed composer", () => {
    const listener = vi.fn();
    const off = onMentionInsert(listener);

    requestMentionInsert({ userId: "u_1", label: "Ali" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ userId: "u_1", label: "Ali" });
    off();
  });

  it("stops delivering after unsubscribe", () => {
    const listener = vi.fn();
    onMentionInsert(listener)();

    requestMentionInsert({ userId: "u_1", label: "Ali" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("is a no-op when no composer is mounted", () => {
    expect(() => requestMentionInsert({ userId: "u_1", label: "Ali" })).not.toThrow();
  });

  it("delivers to every listener, and one unsubscribing mid-dispatch cannot skip another", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offSecond = onMentionInsert(second);
    // The first listener tears the second one down while the dispatch is running
    // — the emitter iterates a COPY, so the second still receives this event.
    const offFirst = onMentionInsert(() => {
      first();
      offSecond();
    });

    requestMentionInsert({ userId: "u_2", label: "Burak" });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    // …and is genuinely gone for the next one.
    requestMentionInsert({ userId: "u_2", label: "Burak" });
    expect(second).toHaveBeenCalledTimes(1);
    offFirst();
  });
});

/**
 * The seam end to end, as the mobile composer runs it.
 *
 * This is the mobile twin of a founder-visible desktop regression: the sheet's
 * "Mention" row inserted at the raw caret, so a caret glued to a word produced
 * `selam@Ali Kara`. `serializeMentions` deliberately refuses to rewrite an `@`
 * that follows a word character (otherwise `mail@host` would become a ping), so
 * the message went out as PLAIN TEXT — the user believed they had tagged
 * someone and nobody was tagged, with nothing visibly wrong (§35).
 *
 * The composer's `onMentionInsert` handler is reproduced here as a tiny stand-in
 * (`Composer.tsx` cannot be imported into a node-only run), asserting the WIRE
 * form — which is the only thing that decides whether a mention is real.
 */
describe("a menu mention reaches the wire as a real mention", () => {
  /** Exactly what the composer's subscription does, minus React. */
  function composerInsert(
    text: string,
    caret: number,
    request: { userId: string; label: string },
  ): { text: string; caret: number; wire: string } {
    const pending: PendingMention[] = [];
    const result = applyMentionInsert(text, Math.min(caret, text.length), {
      id: request.userId,
      label: request.label,
    });
    pending.push(result.pending);
    return { text: result.text, caret: result.caret, wire: serializeMentions(result.text, pending).trim() };
  }

  it("encodes <@id> when the caret is GLUED to a word (the regression)", () => {
    const out = composerInsert("selam", 5, { userId: "u_ali", label: "Ali Kara" });
    expect(out.text).toBe("selam @Ali Kara ");
    expect(out.wire).toBe("selam <@u_ali>");
    // The bug's signature: no separating space, so the token never encodes.
    expect(out.text).not.toContain("selam@Ali");
  });

  it("encodes from an empty composer", () => {
    expect(composerInsert("", 0, { userId: "u_ali", label: "Ali Kara" }).wire).toBe("<@u_ali>");
  });

  it("inserts at the caret, not at the end", () => {
    const out = composerInsert("selam naber", 6, { userId: "u_ali", label: "Ali Kara" });
    expect(out.wire).toBe("selam <@u_ali> naber");
  });

  it("does not double a space that is already there", () => {
    expect(composerInsert("selam ", 6, { userId: "u_ali", label: "Ali Kara" }).text).toBe(
      "selam @Ali Kara ",
    );
  });

  it("leaves the caret just past the inserted token, ready to keep typing", () => {
    const out = composerInsert("selam", 5, { userId: "u_ali", label: "Ali Kara" });
    expect(out.text.slice(0, out.caret)).toBe("selam @Ali Kara ");
  });

  it("carries a nickname-resolved label through unchanged", () => {
    // The sheet passes `resolveUserName(...)`, so a renamed person is mentioned
    // under the name the viewer actually sees — and still encodes to their id.
    const out = composerInsert("hey", 3, { userId: "u_burak", label: "Bur@k the 2nd" });
    expect(out.wire).toBe("hey <@u_burak>");
  });
});
