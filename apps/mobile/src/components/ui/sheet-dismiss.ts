/**
 * The dismissal handshake between a Sheet and its caller.
 *
 * A sheet cannot close itself: it asks (`onClose`) and the caller decides by
 * flipping `visible`. Most callers say yes. Some say "not yet" — the member
 * menu's editors step BACK to the menu on a drag or scrim tap so typed text is
 * never thrown away, and keep `visible` true.
 *
 * So a dismiss request does not animate the card away on its own. It records
 * the release velocity, asks, and waits for the caller's answer:
 *  - the next commit has `visible === false` → the exit takes the velocity and
 *    the card leaves with the finger's momentum;
 *  - the next commit still has `visible === true` → the caller declined, and
 *    the card springs back to its stop from the release point, immediately;
 *  - no commit at all (an `onClose` that changes nothing) → after two frames
 *    the request is treated as declined, so the card can never be left
 *    stranded where the finger let go.
 *
 * Pure TS (no React Native import) so the decision table is unit-tested.
 */

export interface DismissController {
  /**
   * The user asked to close. `velocity` is the drag release speed (px/s,
   * downward positive), or null for a tap on the scrim / the back button.
   */
  request(velocity: number | null): void;
  /** Call after every commit of the sheet, with that commit's `visible`. */
  afterCommit(visible: boolean): void;
  /**
   * The sheet is hiding: hand the pending release velocity to the exit motion
   * (null = no drag behind this close, use the standard exit).
   */
  takeExitVelocity(): number | null;
  /** A request is waiting for the caller's answer. */
  readonly pending: boolean;
}

export function createDismissController(deps: {
  /** Ask the caller to close (the caller's latest `onClose`). */
  close: () => void;
  /** The caller's latest `visible`. */
  isVisible: () => boolean;
  /** Return the card to its current stop, carrying `velocity`. */
  springBack: (velocity: number) => void;
  /** Run `fn` once the caller has had a chance to commit. */
  later: (fn: () => void) => void;
}): DismissController {
  let pending: { velocity: number | null } | null = null;

  const declineIfStillVisible = () => {
    if (!pending) return;
    const { velocity } = pending;
    pending = null;
    if (deps.isVisible()) deps.springBack(velocity ?? 0);
  };

  return {
    request(velocity) {
      pending = { velocity };
      deps.close();
      deps.later(declineIfStillVisible);
    },
    afterCommit(visible) {
      if (pending && visible) declineIfStillVisible();
    },
    takeExitVelocity() {
      const velocity = pending?.velocity ?? null;
      pending = null;
      return velocity;
    },
    get pending() {
      return pending !== null;
    },
  };
}
