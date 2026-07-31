/**
 * Source-level invariants for the group-DM invite screen on MOBILE (M18).
 *
 * Four things can rot here and none of them shows up as a type error:
 *
 *  1. The owner-only revoke gate becomes a hand-written `ownerId === me.id`
 *     again. The API answers 403 to everyone but the owner, so the moment the
 *     two clients stop reading ONE rule they start disagreeing about who sees a
 *     revoke button — and the loser sees a control that can only fail (§35).
 *  2. The gate degrades from "not rendered" to "rendered but disabled". A
 *     disabled revoke tells a plain member the capability exists and is merely
 *     switched off, which is both a lie and a permission hint.
 *  3. The screen hand-builds a link. There is exactly ONE deep-link shape in the
 *     product because the redeem endpoint is shared with server invites; a
 *     second template here would produce links the native intent filters do not
 *     match, so they would open a browser instead of the app.
 *  4. Creating picks up an owner gate by proximity. Any member may mint a link —
 *     gating it would make the feature useless in exactly the groups that want
 *     it, and nothing server-side asks for that.
 *
 * The mobile app has no RN render harness (node-environment vitest, see
 * vitest.config.ts), so the repo's established way to assert component wiring is
 * to read the source — the same technique `voice-channel-chat-wiring.test.ts`
 * and the desktop renderer use.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The mobile tsconfig pulls in DOM lib, whose `URL` is not node's — so resolve
// this file's directory from the string form and join, rather than `new URL()`.
const HERE = dirname(fileURLToPath(import.meta.url));

const read = (relative: string): string => readFileSync(join(HERE, relative), "utf8");

const screen = read("../../../app/(app)/group-chat-invite.tsx");
const details = read("../../../app/(app)/group-chat-details.tsx");
const queries = read("../../queries/group-chat-queries.ts");

describe("revoke is owner-only, and decided by the shared rule", () => {
  it("asks @demli/client-core instead of comparing ids itself", () => {
    expect(screen).toMatch(/canRevokeGroupChatInvite\(/);
    expect(screen).toMatch(/from "@demli\/client-core"/);
    // A second hand-written comparison is exactly the drift the shared rule
    // exists to prevent.
    expect(screen).not.toMatch(/ownerId\s*===\s*me/);
    expect(screen).not.toMatch(/isOwner\s*=/);
  });

  it("renders the revoke control conditionally — absent, never disabled-by-permission", () => {
    expect(screen).toMatch(/\{canRevoke \?/);
    // `disabled={busy}` is legitimate (an in-flight request), but the gate must
    // never be expressed as a disabled state.
    expect(screen).not.toMatch(/disabled=\{!canRevoke/);
    expect(screen).not.toMatch(/disabled=\{!isOwner/);
  });

  it("tells a non-owner why, once they actually have a link to look at", () => {
    expect(screen).toMatch(/!canRevoke && invites\.length > 0/);
    expect(screen).toMatch(/groupChatInvite\.ownerOnlyRevoke/);
  });

  it("confirms a revoke in two taps rather than firing on the first", () => {
    expect(screen).toMatch(/confirmingRevoke === invite\.id/);
    expect(screen).toMatch(/groupChatInvite\.revokeConfirm/);
    expect(screen).toMatch(/groupChatInvite\.revokeBody/);
  });
});

describe("there is exactly one deep-link shape", () => {
  it("builds every link through the shared mobile builder", () => {
    expect(screen).toMatch(/import \{ buildInviteLink \} from "@\/lib\/deep-links"/);
    expect(screen).toMatch(/buildInviteLink\(invite\.code\)/);
  });

  it("hand-writes no URL of its own", () => {
    // A literal origin here would bypass the builder whose host/path the native
    // intent filters are registered for.
    expect(screen).not.toMatch(/https:\/\//);
    expect(screen).not.toMatch(/demli:\/\/join\//);
  });
});

describe("creating a link is open to every member", () => {
  it("keeps the create button outside the owner gate", () => {
    const create = screen.slice(screen.indexOf("const onCreate"), screen.length);
    expect(create).toMatch(/createInvite\.mutate\(/);
    // The create <Button> block itself must not sit inside a canRevoke/isOwner
    // branch. (The owner-only footnote that follows it legitimately mentions
    // canRevoke, so the slice stops at the button's closing tag.)
    const buttonStart = screen.indexOf('variant={invites.length > 0 ? "ghost" : "primary"}');
    const button = screen.slice(buttonStart, screen.indexOf("</Button>", buttonStart));
    expect(buttonStart).toBeGreaterThan(-1);
    expect(button).not.toMatch(/canRevoke/);
    expect(button).not.toMatch(/isOwner/);
  });

  it("is reachable from the group's details screen by any member", () => {
    expect(details).toMatch(/pathname: "\/group-chat-invite"/);
    const entry = details.slice(
      details.indexOf("groupChatInvite.menuItem") - 400,
      details.indexOf("groupChatInvite.menuItem"),
    );
    expect(entry).not.toMatch(/isOwner \?/);
  });
});

describe("limit arithmetic is shared, not re-derived per platform", () => {
  it("reads the remaining life from the shared inviteUsage rule", () => {
    expect(screen).toMatch(/inviteUsage\(/);
    expect(screen).toMatch(/prefersDaysWording\(/);
  });

  it("does no date or use-count math of its own", () => {
    // The clamping ("never show -3 hours") lives in client-core; a local copy is
    // how one surface starts disagreeing with the other.
    expect(screen).not.toMatch(/3_600_000/);
    expect(screen).not.toMatch(/getTime\(\)/);
    expect(screen).not.toMatch(/Math\.max\(0,/);
  });
});

describe("the invite cache stands on its own", () => {
  it("invalidates only the invite list, never the roster", () => {
    const hooks = queries.slice(
      queries.indexOf("export function useGroupChatInvites"),
      queries.indexOf("Delete a flat group chat"),
    );
    expect(hooks).toMatch(/queryKeys\.groupChatInvites\(groupChatId\)/);
    expect(hooks).not.toMatch(/queryKeys\.groupChatDetails/);
    // A link grants nobody new channel access, so re-handshaking the gateway
    // here would be a needless reconnect on every create.
    expect(hooks).not.toMatch(/resubscribeRealtime/);
  });
});
