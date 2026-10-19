/**
 * The in-app banner's release rule, kept pure so node tests pin it (the banner
 * calls it from the pan gesture's `onFinalize`, a Reanimated worklet).
 *
 * The auto-dismiss timer pauses on touch-down. Every way a touch can end must
 * then either dismiss the banner or restart the timer — otherwise the banner
 * stays pinned over the native header until it is tapped. That includes a pan
 * that never activated (a sideways swipe tripping `failOffsetX`, the OS taking
 * the touch for the notification shade): RNGH only calls `onEnd` for a gesture
 * that became ACTIVE, but it always calls `onFinalize`, so the decision lives
 * there and covers all three endings.
 */

/** Past this upward travel (px) or speed (px/s) a release dismisses. */
export const BANNER_SWIPE_DISTANCE = 28;
export const BANNER_SWIPE_VELOCITY = 600;

export type BannerRelease = "dismiss" | "rearm";

/**
 * What a finished touch on the banner does.
 *
 * @param activated RNGH `onFinalize`'s `success`: the pan went active and ended
 *   normally. A failed or cancelled pan never dismisses, however far it moved.
 */
export function bannerRelease(
  activated: boolean,
  translationY: number,
  velocityY: number,
): BannerRelease {
  "worklet";
  if (!activated) return "rearm";
  return translationY < -BANNER_SWIPE_DISTANCE || velocityY < -BANNER_SWIPE_VELOCITY
    ? "dismiss"
    : "rearm";
}
