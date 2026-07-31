// @vitest-environment jsdom
/**
 * "Right-click a user → Profile" must actually open the profile card.
 *
 * A pure test cannot see this bug. The menu entry ran, the trigger was found,
 * the popover's open state flipped to `true` — every unit was correct, and the
 * card still never appeared, because a Radix menu and a Radix popover disagree
 * about who owns focus while one is closing and the other opening:
 *
 *   - an OPEN menu traps focus and pulls back anything that lands outside it;
 *   - a popover is a dismissable layer, and reads "focus went outside" as a
 *     dismissal;
 *   - and on close, the menu's FocusScope restores focus in a `setTimeout(0)`,
 *     landing outside the card that just opened.
 *
 * So this file mounts the real components and asserts the OUTCOME the founder
 * checks: after selecting the entry, the card is on screen and still there once
 * every deferred focus callback has run.
 *
 * The harness (../test/dom) mounts on `document.body` with a single React copy;
 * see its header for why neither is optional here.
 */
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ContextMenuItem, Popover, PopoverContent, PopoverTrigger } from "@demli/ui";
import { ActionMenu, useActionMenuAfterClose, useActionMenuTrigger } from "./ActionMenu";
import { clickMenuItem, findByText, findMenuItem, flush, mount, press } from "../test/dom";

const CARD = "PROFILE_CARD";

/**
 * The desktop MemberContextMenu's `openProfileFrom`, verbatim: find the profile
 * popover's trigger INSIDE the element this menu is attached to, and click it.
 * Scoped to the menu's own trigger because a document-wide lookup would open the
 * first roster row's card rather than the right-clicked one.
 */
function openProfileFrom(trigger: HTMLElement | null): void {
  const node =
    trigger?.matches("[data-profile-trigger]") === true
      ? trigger
      : trigger?.querySelector<HTMLElement>("[data-profile-trigger]");
  node?.click();
}

function MenuBody(): JSX.Element {
  const triggerRef = useActionMenuTrigger();
  const afterClose = useActionMenuAfterClose();
  return (
    <>
      <ContextMenuItem
        onSelect={() => {
          // Capture the node NOW — the ref is cleared as the menu tears down.
          const trigger = triggerRef?.current ?? null;
          afterClose(() => openProfileFrom(trigger));
        }}
      >
        Profile
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => undefined}>Copy user ID</ContextMenuItem>
    </>
  );
}

/** A roster row: the menu wraps the <li>, the popover wraps the row's button. */
function Row(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <ActionMenu menu={<MenuBody />}>
      <li data-testid="row">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button type="button" data-profile-trigger="u1">
              avatar
            </button>
          </PopoverTrigger>
          <PopoverContent>{CARD}</PopoverContent>
        </Popover>
      </li>
    </ActionMenu>
  );
}

function openMenu(): void {
  const row = document.querySelector<HTMLElement>("[data-testid='row']");
  press(() => {
    row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
}

describe("user menu → Profile", () => {
  it("opens the profile card and leaves it open", async () => {
    const view = mount(<Row />);
    openMenu();
    await flush(5);

    const item = findMenuItem("Profile");
    expect(item, "the context menu did not open").not.toBeNull();

    press(() => clickMenuItem(item!));
    await flush(5);
    expect(findByText(CARD), "the card never opened").not.toBeNull();

    // The menu's focus restore fires on a later macrotask; the card must survive
    // it. This is the half that regressed: before the fix the card opened and
    // was dismissed again before it was ever painted.
    await flush(50);
    expect(findByText(CARD), "the card was dismissed after opening").not.toBeNull();

    view.unmount();
  });

  it("closes the menu itself", async () => {
    const view = mount(<Row />);
    openMenu();
    await flush(5);
    press(() => clickMenuItem(findMenuItem("Profile")!));
    await flush(50);

    expect(findMenuItem("Profile"), "the menu stayed open behind the card").toBeNull();
    view.unmount();
  });

  it("still returns focus to the row when an entry opens nothing", async () => {
    // The focus suppression must be per-select. An entry that hands focus to
    // nobody has to leave Radix's normal restore alone, or keyboard users lose
    // their place in the roster every time they copy an id.
    const view = mount(<Row />);
    const rowButton = document.querySelector<HTMLElement>("[data-profile-trigger]")!;
    press(() => rowButton.focus());
    expect(document.activeElement).toBe(rowButton);

    openMenu();
    await flush(5);

    press(() => clickMenuItem(findMenuItem("Copy user ID")!));
    await flush(50);

    expect(document.activeElement, "focus was not returned to the row").toBe(rowButton);
    view.unmount();
  });
});
