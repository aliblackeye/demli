/**
 * The pure half of the pin permission rule (M17).
 *
 * This is COSMETIC gating — the API re-checks every pin — but it is exactly the
 * kind of boolean that quietly inverts during a refactor and either hides the
 * action from the message's own author or shows it to everyone. The rule is
 * asserted here rather than proven by clicking, because the founder-device pass
 * cannot cover the permission matrix (it needs several accounts and roles).
 *
 * The rule, verbatim from the API contract:
 *   - the message's OWN author may pin it;
 *   - a member with MANAGE_MESSAGES (or the server owner) may pin anything;
 *   - in DMs and flat group chats there are no roles, which the caller expresses
 *     by passing `canManageMessages = true` (see `useCanManageMessages`).
 */

import { describe, expect, it } from "vitest";
import type { UserId } from "@demli/types";
import { canPinMessage } from "../pin-rule";

const ME = "user-me" as UserId;
const OTHER = "user-other" as UserId;

describe("canPinMessage", () => {
  it("lets a member pin their OWN message without MANAGE_MESSAGES", () => {
    expect(canPinMessage(false, ME, ME)).toBe(true);
  });

  it("does NOT let a plain member pin someone else's message", () => {
    expect(canPinMessage(false, OTHER, ME)).toBe(false);
  });

  it("lets MANAGE_MESSAGES pin anyone's message", () => {
    expect(canPinMessage(true, OTHER, ME)).toBe(true);
  });

  it("denies everything when there is no session user and no permission", () => {
    // Signed-out / mid-account-switch: the safe answer is "no action offered".
    expect(canPinMessage(false, OTHER, undefined)).toBe(false);
    expect(canPinMessage(false, ME, undefined)).toBe(false);
  });

  it("still allows the DM / group-chat case (no roles ⇒ everyone may pin)", () => {
    // `useCanManageMessages(null)` returns true for those surfaces, so any
    // author is pinnable there — including one we cannot identify.
    expect(canPinMessage(true, OTHER, undefined)).toBe(true);
  });
});
