/**
 * Source-level invariant: BOTH clients assert their presence on every connect,
 * including when it is plain "online".
 *
 * The bug this pins (founder, 2026-07-28: "bilgisayarda aktifim hala dışarıda
 * gözüküyorum, ama durum ayarla kısmında çevrimiçi seçili"):
 *
 * `presence:status:<userId>` in Redis is per-USER, carries no TTL, and is only
 * deleted when that user's LAST connection disconnects. So a device that
 * auto-flipped to "idle" and then went away — app closed, machine slept — while
 * another session stayed connected leaves "idle" behind. Both clients used to
 * SKIP the presence frame when their effective status was "online", on the
 * theory that a fresh socket lands on the gateway's default. It does not: it
 * inherits the stale value. The user is at their keyboard, their own picker
 * reads "Çevrimiçi", and their friends see the amber dot — with nothing in any
 * log, because every component behaved exactly as written.
 *
 * The skip is a one-line "optimisation" that reads as obviously correct (why
 * send a frame that changes nothing?), which is why it is pinned here rather
 * than left for a reviewer to catch. Cost of the frame: a few bytes per
 * connection. Cost of the skip: presence lies.
 *
 * A behavioural test would need a real socket plus a gateway holding stale
 * state; this repo pins that class of regression at the source instead
 * (see lib/user-menu-wiring.test.ts for the same pattern).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLIENTS = {
  desktop: fileURLToPath(new URL("./connection.ts", import.meta.url)),
  mobile: fileURLToPath(
    new URL("../../../../../mobile/src/realtime/connection.ts", import.meta.url),
  ),
} as const;

describe.each(Object.entries(CLIENTS))("%s — presence on connect", (_name, path) => {
  const source = readFileSync(path, "utf8");

  it("does not gate the handshake presence frame on the status being non-online", () => {
    // The exact shape of the regression, in both files it lived in.
    expect(source).not.toContain('effective !== "online"');
  });

  it("still sends the effective status (not a hardcoded online) after auth", () => {
    // Guards the other direction: asserting unconditionally is only correct while
    // the value asserted is the EFFECTIVE one, so a picked dnd/invisible and a
    // live auto-away survive the reconnect instead of being flattened to online.
    expect(source).toMatch(/presenceUpdate\(\{\s*userId: me\.id,\s*status: effective\s*\}\)/);
  });
});

/**
 * Source-level invariant (M16): BOTH clients route presence about THEIR OWN user
 * through the shared @demli/client-core rules, so an invisible user's own dot
 * can never be repainted "offline" — the bug a pre-M16 gateway caused by sending
 * the user their own PEER-masked presence, live and in the handshake snapshot.
 * The rules themselves are unit-tested in client-core (self-presence.test.ts);
 * this pins that both handlers still call them.
 */
describe.each(Object.entries(CLIENTS))("%s — presence about ourselves", (_name, path) => {
  const source = readFileSync(path, "utf8");

  /** The body of one `case SERVER_EVENT.<name>` up to the next `case`. */
  function caseBody(name: string): string {
    const start = source.indexOf(`case SERVER_EVENT.${name}:`);
    expect(start, `case SERVER_EVENT.${name} not found`).toBeGreaterThan(-1);
    const next = source.indexOf("case SERVER_EVENT.", start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  }

  it("drops a self `offline` before painting presence.updated", () => {
    const body = caseBody("presenceUpdated");
    const guard = body.indexOf("isStaleSelfPresence(event.payload, useAuthStore.getState().user?.id)");
    const paint = body.indexOf("chat.setPresence(");
    expect(guard).toBeGreaterThan(-1);
    expect(paint).toBeGreaterThan(guard);
  });

  it("strips any self entry from the auth.succeeded snapshot before seeding our own", () => {
    const body = caseBody("authSucceeded");
    expect(body).toContain("withoutSelfPresence(event.payload.presence, me?.id)");
    // The old shape copied the snapshot verbatim, self entry included.
    expect(body).not.toContain("[...event.payload.presence]");
  });
});
