/**
 * ActionMenu — the SINGLE abstraction for "row / tile action menus" across the
 * single-source renderer (desktop + web). It gives every menu THREE ways in so a
 * touch user is never locked out of a right-click-only menu (founder: "web'de
 * mobilde sağ-tık yok"):
 *
 *   1. pointer:fine (mouse)  → native right-click, opening at the cursor. This is
 *      the UNCHANGED Radix ContextMenu path — wide-screen behaviour is identical
 *      to before (no regression).
 *   2. pointer:coarse (touch)→ a tuned ~480ms long-press opens the SAME menu at
 *      the press point (see ./longPress). Only touch/pen arm it; a mouse never
 *      does, so path 1 is untouched. Scroll/drag cancels it (movement threshold),
 *      and we never set `touch-action: none`, so list scrolling is never broken.
 *   3. a visible kebab (⋮)   → optional. On a coarse pointer or a narrow viewport
 *      the kebab is always shown (discoverable without hover); on a fine pointer
 *      it reveals on row hover (the pre-existing affordance). A tap opens the menu.
 *
 * DRY: callers pass the menu body once (`menu`) and their trigger surface as the
 * single child; ActionMenu wires all three paths and the a11y. The menu body
 * keeps using the shared `ContextMenuItem` / `ContextMenuLabel` / … primitives
 * from `@demli/ui`, so existing menu content moves over verbatim.
 *
 * Opening from a control that is NOT the Radix trigger (the injected kebab, or a
 * caller's own kebab inside an <li>) is done by {@link openActionMenuAt}, which
 * dispatches a bubbling `contextmenu` at a point — the same mechanism the voice
 * roster already used, generalised here.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { MoreVertical } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  cn,
} from "@demli/ui";
import {
  createLongPress,
  DEFAULT_LONG_PRESS_MS,
  type LongPressPoint,
} from "./longPress";

/**
 * Open an ActionMenu (a Radix ContextMenu) at a viewport point by dispatching a
 * bubbling `contextmenu` on `node`. `node` may be the trigger itself, or any
 * descendant of it (the event bubbles up to the trigger's `onContextMenu`).
 * No-op when `node` is null.
 */
export function openActionMenuAt(node: HTMLElement | null, clientX: number, clientY: number): void {
  if (!node) return;
  node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX, clientY }));
}

/** What an open menu's body may ask of the menu around it. */
interface ActionMenuHandle {
  /**
   * The trigger element the OPEN menu belongs to.
   *
   * A menu entry sometimes has to act on the row that opened it rather than on
   * global state — the user menu's "Profile" entry, for instance, opens the
   * profile popover that is anchored to THAT row's avatar. Scoping the lookup to
   * this node is what keeps it unambiguous when fifty rows render the same
   * affordance; a document-wide query would open the first row's card, not the
   * right-clicked one.
   */
  triggerRef: MutableRefObject<HTMLElement | null>;
  /** See {@link useActionMenuAfterClose}. */
  afterClose: (action: () => void) => void;
}

const ActionMenuContext = createContext<ActionMenuHandle | null>(null);

/**
 * The DOM node of the trigger this menu is attached to, or null outside an
 * ActionMenu. Read it inside an event handler — during render the ref may not
 * be attached yet.
 */
export function useActionMenuTrigger(): MutableRefObject<HTMLElement | null> | null {
  return useContext(ActionMenuContext)?.triggerRef ?? null;
}

/**
 * Run an entry's action AFTER this menu has finished closing, and stop the
 * closing menu from clawing focus back. Any entry that opens another floating
 * surface — the profile popover, a dialog — must go through here.
 *
 * This is the "Profile does nothing" fix (reproduced in
 * ActionMenu.profile.test.tsx; the two mechanisms below were read off the
 * installed Radix sources, not guessed):
 *
 *   1. While the menu is open, Radix's FocusScope runs TRAPPED: a document
 *      `focusin` landing outside the menu is pulled straight back into the menu
 *      content. Opening a popover synchronously from `onSelect` therefore hands
 *      the popover focus and has it yanked away in the same tick — and the
 *      popover, being a DismissableLayer, reads that as "focus went outside" and
 *      dismisses itself. The card opens and closes before it is ever painted.
 *   2. Even once the menu is gone, FocusScope's unmount cleanup schedules
 *      `focus(previouslyFocusedElement)` in a `setTimeout(…, 0)` — landing
 *      outside the freshly opened popover, dismissing it a macrotask later.
 *
 * So both halves are needed: defer the action past the menu's unmount (a
 * microtask, which runs after React has committed the close), and preventDefault
 * the close-auto-focus so step 2 never fires for this one close.
 *
 * The focus suppression is per-select on purpose: every OTHER way of closing
 * (Escape, click-away, an entry that opens nothing) must keep returning focus to
 * the row — the a11y behaviour Radix gives us for free.
 *
 * Outside an ActionMenu the action simply runs inline, so a menu body is still
 * usable in isolation.
 */
export function useActionMenuAfterClose(): (action: () => void) => void {
  const handle = useContext(ActionMenuContext);
  return handle?.afterClose ?? runInline;
}

function runInline(action: () => void): void {
  action();
}

/**
 * Suppress the iOS long-press text-selection + callout bubble on the trigger.
 * (Radix already sets `WebkitTouchCallout: none`; we add user-select so the hold
 * never starts a selection.) NB: intentionally no `touchAction` — leaving native
 * scrolling intact is what lets a scroll cancel the pending press.
 */
const TRIGGER_STYLE: CSSProperties = {
  WebkitUserSelect: "none",
  userSelect: "none",
  WebkitTouchCallout: "none",
};

function useLongPressHandlers(
  onLongPress: (point: LongPressPoint) => void,
  durationMs: number,
  disabled: boolean,
): {
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  onPointerCancel: (e: ReactPointerEvent) => void;
} {
  // Always call the latest callback without re-creating the controller.
  const cbRef = useRef(onLongPress);
  cbRef.current = onLongPress;

  const controller = useMemo(
    () => createLongPress({ durationMs, onLongPress: (p) => cbRef.current(p) }),
    [durationMs],
  );

  // Clear any pending press on unmount, or the moment the menu is disabled.
  useEffect(() => controller.cancel, [controller]);
  useEffect(() => {
    if (disabled) controller.cancel();
  }, [disabled, controller]);

  return {
    onPointerDown: controller.onPointerDown,
    onPointerMove: controller.onPointerMove,
    onPointerUp: controller.onPointerUp,
    onPointerCancel: controller.onPointerCancel,
  };
}

/**
 * The kebab "…" affordance for the touch/narrow paths. It is deliberately
 * INERT + invisible on a fine-pointer wide desktop (`opacity-0` +
 * `pointer-events-none`), so the wide-screen row looks and behaves exactly as it
 * did before (no new hover chrome, no click target over the badges) — the task's
 * "only touch/narrow gains extra access" rule. It reveals + becomes clickable on
 * a coarse pointer, a narrow viewport, or keyboard focus (the last a small a11y
 * win over the previous right-click-only menus). Positioned absolutely so it
 * never affects the row's layout in any mode. A tap opens the menu and never
 * bubbles into the row's own click.
 */
export function ActionMenuKebab({
  label,
  onOpen,
  className,
}: {
  label: string;
  onOpen: (clientX: number, clientY: number) => void;
  className?: string;
}): ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      // Do not let the press reach the row (would arm the row long-press / click).
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        onOpen(rect.left, rect.bottom);
      }}
      className={cn(
        "absolute right-1 top-1/2 z-10 grid size-6 -translate-y-1/2 place-items-center rounded-md",
        "text-fg-faint transition-[opacity,color,background-color] motion-instant",
        "hover:bg-white/[0.06] hover:text-fg",
        // Hidden + inert on a POINTER THAT CAN HOVER; shown + interactive when
        // it cannot, and under keyboard focus.
        //
        // Width used to be part of this ("narrow viewport"), and it was wrong: a
        // desktop window dragged narrow still has a mouse, so every kebab in the
        // app pinned itself on and the UI read as permanently hovered (founder,
        // 2026-07-28, on a 2560px display in a ~590px window). `pointer-coarse`
        // asks the question that actually matters.
        "opacity-0 pointer-events-none",
        "focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        "pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
        className,
      )}
    >
      <MoreVertical className="size-4" aria-hidden />
    </button>
  );
}

export interface ActionMenuKebabConfig {
  /** aria-label for the kebab (i18n) — required so the icon-only button is named. */
  label: string;
  /** Position/size overrides for the injected kebab. */
  className?: string;
}

export interface ActionMenuProps {
  /** The trigger surface — a single element (a row button, an <li>, a rail tile …). */
  children: ReactElement;
  /** The menu body: `ContextMenuItem` / `ContextMenuLabel` / `ContextMenuSeparator` / … */
  menu: ReactNode;
  /** className for the menu content panel (e.g. "w-56"). */
  contentClassName?: string;
  /**
   * Inject a visible kebab next to the trigger. When set, ActionMenu wraps the
   * trigger + kebab in a `relative` group container, so ONLY use it when a wrapper
   * is layout-safe (e.g. inside a flex/`div` list — NOT for an `<li>` that must be
   * a direct child of a `<ul>`; those surfaces render their own in-row kebab and
   * call {@link openActionMenuAt}). Omit to get long-press + right-click only.
   */
  kebab?: ActionMenuKebabConfig;
  /** Extra classes for the injected-kebab wrapper (width/layout of the row container). */
  wrapperClassName?: string;
  /**
   * An extra control rendered as a SIBLING of the trigger inside the same
   * `relative` wrapper — for a row whose primary click does one thing and which
   * needs a second, always-reachable action next to it (the voice channel row's
   * "join", whose row click opens the channel's chat instead).
   *
   * It must position itself absolutely (the wrapper is `relative`), and it must
   * stop its own pointer events from reaching the row. Requires `kebab` — that
   * is what creates the wrapper; without it there is nothing to position against.
   */
  trailing?: ReactNode;
  /** Disable all three trigger paths (still renders the child). */
  disabled?: boolean;
  /** Hold duration for the touch long-press. Default 480ms. */
  longPressMs?: number;
  /** Notified when the menu opens/closes (forwarded to the Radix root). */
  onOpenChange?: (open: boolean) => void;
}

/**
 * Wrap a trigger surface with a right-click + long-press + optional-kebab action
 * menu. See the file header for the three trigger paths.
 */
export function ActionMenu({
  children,
  menu,
  contentClassName,
  kebab,
  wrapperClassName,
  trailing,
  disabled = false,
  longPressMs = DEFAULT_LONG_PRESS_MS,
  onOpenChange,
}: ActionMenuProps): ReactElement {
  const triggerRef = useRef<HTMLElement | null>(null);
  // Armed by an entry that hands focus onward as it closes the menu; consumed
  // (and cleared) by the single close it was armed for.
  const keepFocusRef = useRef(false);
  // The deferred action of the entry that was just selected, if any.
  const afterCloseRef = useRef<(() => void) | null>(null);

  const handle = useMemo<ActionMenuHandle>(
    () => ({
      triggerRef,
      afterClose: (action) => {
        keepFocusRef.current = true;
        afterCloseRef.current = action;
      },
    }),
    [],
  );

  const lp = useLongPressHandlers(
    (point) => openActionMenuAt(triggerRef.current, point.clientX, point.clientY),
    longPressMs,
    disabled,
  );

  const trigger = (
    <ContextMenuTrigger
      asChild
      disabled={disabled}
      ref={triggerRef}
      style={TRIGGER_STYLE}
      onPointerDown={lp.onPointerDown}
      onPointerMove={lp.onPointerMove}
      onPointerUp={lp.onPointerUp}
      onPointerCancel={lp.onPointerCancel}
    >
      {children}
    </ContextMenuTrigger>
  );

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) {
          // A fresh open must never inherit the previous close's state.
          keepFocusRef.current = false;
          afterCloseRef.current = null;
        } else {
          const action = afterCloseRef.current;
          afterCloseRef.current = null;
          // A microtask, not a timeout: it runs after React has committed this
          // close (so the menu — and its focus trap — is gone) but still before
          // FocusScope's `setTimeout(0)` restore, which we suppress below.
          if (action) queueMicrotask(action);
        }
        onOpenChange?.(open);
      }}
    >
      {kebab ? (
        <div className={cn("group/actionmenu relative flex w-full min-w-0", wrapperClassName)}>
          {trigger}
          {trailing}
          {!disabled && (
            <ActionMenuKebab
              label={kebab.label}
              className={kebab.className}
              onOpen={(x, y) => openActionMenuAt(triggerRef.current, x, y)}
            />
          )}
        </div>
      ) : (
        trigger
      )}
      <ContextMenuContent
        className={contentClassName}
        // Radix restores focus to the trigger here (via FocusScope's unmount
        // auto-focus). An entry that deferred work past the close has already
        // armed the suppression, because that restore lands OUTSIDE whatever the
        // entry opened — which a DismissableLayer reads as "interacted outside"
        // and closes one macrotask after it opened. See useActionMenuAfterClose.
        onCloseAutoFocus={(event) => {
          if (!keepFocusRef.current) return;
          keepFocusRef.current = false;
          event.preventDefault();
        }}
      >
        <ActionMenuContext.Provider value={handle}>{menu}</ActionMenuContext.Provider>
      </ContextMenuContent>
    </ContextMenu>
  );
}
