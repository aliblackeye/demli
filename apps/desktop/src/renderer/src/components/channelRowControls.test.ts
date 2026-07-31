/**
 * The channel row's trailing controls: who gets them, and where they are
 * actually visible.
 *
 * Both halves are founder requirements with a specific failure mode:
 *
 *   - a member the server would refuse an invite must see NO invite control
 *     (their reference screenshot has no such row) — and "shows it disabled" is
 *     just as wrong as showing it enabled;
 *   - the control must be PERMANENTLY visible where there is no hover. A
 *     hover-only icon is not a subtle icon on a phone, it is a missing feature,
 *     and it is invisible to review on a desktop with a mouse.
 *
 * The reveal assertions read the class strings because that is the only honest
 * thing to assert: jsdom evaluates no media queries, so a "render it and check
 * visibility" test would pass whatever the classes said.
 */

import { describe, expect, it } from "vitest";
import {
  ALWAYS_VISIBLE_CLASS,
  HOVER_REVEAL_CLASSES,
  planChannelRowControls,
  trailingPaddingClasses,
} from "./channelRowControls";

describe("who gets an invite control", () => {
  it("gives none to a viewer who may not invite — text row", () => {
    const plan = planChannelRowControls({
      isVoice: false,
      canInvite: false,
      selected: false,
    });
    expect(plan.showInviteControl).toBe(false);
    expect(plan.slots).toBe(0);
    // Nothing to reserve room for: the row keeps its plain padding.
    expect(plan.paddingClasses).toBeNull();
  });

  it("gives none to a viewer who may not invite — even on the SELECTED row", () => {
    // Selection reveals the control; it must never CREATE one.
    const plan = planChannelRowControls({ isVoice: false, canInvite: false, selected: true });
    expect(plan.showInviteControl).toBe(false);
  });

  it("gives none to a viewer who may not invite — even on a voice row", () => {
    const plan = planChannelRowControls({ isVoice: true, canInvite: false, selected: false });
    expect(plan.showInviteControl).toBe(false);
    // The voice chat control is unrelated to invites and survives.
    expect(plan.showChatControl).toBe(true);
    expect(plan.slots).toBe(1);
  });

  it("gives one to a viewer who may invite", () => {
    const plan = planChannelRowControls({ isVoice: false, canInvite: true, selected: false });
    expect(plan.showInviteControl).toBe(true);
    expect(plan.slots).toBe(1);
  });
});

describe("where the invite control is visible", () => {
  it("is hover-revealed on an unselected row, and permanent on touch / narrow", () => {
    const { inviteRevealClasses } = planChannelRowControls({
      isVoice: false,
      canInvite: true,
      selected: false,
    });
    expect(inviteRevealClasses).toBe(HOVER_REVEAL_CLASSES);
    // The two that matter, asserted individually so a partial regression
    // (dropping just the coarse-pointer half) cannot slip through.
    expect(inviteRevealClasses).toContain("group-hover/actionmenu:opacity-100");
    expect(inviteRevealClasses).toContain("pointer-coarse:opacity-100");
    // …and clickable there, not merely painted.
    expect(inviteRevealClasses).toContain("pointer-coarse:pointer-events-auto");

    // WIDTH MUST NOT PIN IT ON. A narrow desktop window still has a mouse, so a
    // width rule here made every row control permanently visible and the sidebar
    // looked stuck in a hover state (founder, 2026-07-28). Asserted as an
    // ABSENCE because that is the regression: someone re-adding "narrow = touch"
    // would otherwise only be caught by eye, in a window size nobody tests at.
    expect(inviteRevealClasses).not.toContain("max-[899px]");
  });

  it("is permanently visible while the row is SELECTED", () => {
    const { inviteRevealClasses } = planChannelRowControls({
      isVoice: false,
      canInvite: true,
      selected: true,
    });
    expect(inviteRevealClasses).toBe(ALWAYS_VISIBLE_CLASS);
    expect(inviteRevealClasses).not.toContain("opacity-0");
  });

  it("keeps the voice chat control hover-secondary regardless of selection", () => {
    // Only the INVITE icon gained the selected exemption; pinning the chat icon
    // on too would put two permanent icons on the row you are reading.
    const plan = planChannelRowControls({ isVoice: true, canInvite: true, selected: true });
    expect(plan.chatRevealClasses).toBe(HOVER_REVEAL_CLASSES);
    expect(plan.inviteRevealClasses).toBe(ALWAYS_VISIBLE_CLASS);
  });
});

describe("row padding reservation", () => {
  it("reserves nothing when the row has no trailing control", () => {
    expect(trailingPaddingClasses(0)).toBeNull();
  });

  it("reserves one slot, plus the always-on kebab on touch / narrow", () => {
    const classes = trailingPaddingClasses(1) ?? "";
    expect(classes).toContain("pr-9");
    expect(classes).toContain("pointer-coarse:pr-16");
    expect(classes).toContain("max-[899px]:pr-16");
  });

  it("reserves more for a voice row that can also be invited to", () => {
    const plan = planChannelRowControls({ isVoice: true, canInvite: true, selected: false });
    expect(plan.slots).toBe(2);
    const classes = plan.paddingClasses ?? "";
    expect(classes).toContain("pr-16");
    expect(classes).toContain("pointer-coarse:pr-24");
    expect(classes).toContain("max-[899px]:pr-24");
  });

  it("reserves on EVERY pointer, not only on hover", () => {
    // Reserving on hover would shove the unread count sideways the instant the
    // pointer crossed the row — the padding must be unconditional.
    for (const slots of [1, 2]) {
      const classes = trailingPaddingClasses(slots) ?? "";
      expect(classes).not.toContain("hover:");
    }
  });
});
