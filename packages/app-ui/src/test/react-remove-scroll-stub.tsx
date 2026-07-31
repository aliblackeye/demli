/**
 * Test-only stand-in for `react-remove-scroll`, aliased in vitest.config.ts.
 *
 * WHY: `.npmrc` pins `node-linker=hoisted` (Metro/Gradle need a flat layout), so
 * a transitive dep can carry its OWN physical copy of react@18.3.1. Two copies =
 * two hook dispatchers, and any component from the duplicate throws
 * "Cannot read properties of null (reading 'useRef')". Vite aliases fix that for
 * everything it transforms; `react-remove-scroll` ships CJS whose `require("react")`
 * is resolved by Node, out of Vite's reach.
 *
 * Replacing it is safe for these tests: Radix uses it only to lock body scroll
 * behind a modal menu/popover. jsdom has no scrolling, so the real module's only
 * job is a no-op here — while the focus, dismiss and portal behaviour we actually
 * assert on comes from other Radix packages that Vite does transform.
 */
import { forwardRef, type ReactNode } from "react";

interface StubProps {
  children?: ReactNode;
}

export const RemoveScroll = Object.assign(
  forwardRef<HTMLElement, StubProps>(function RemoveScrollStub({ children }, _ref) {
    return <>{children}</>;
  }),
  { classNames: { fullWidth: "", zeroRight: "" } },
);

export const RemoveScrollBar = RemoveScroll;
export const fullWidthClassName = "";
export const zeroRightClassName = "";
export const noScrollbarsClassName = "";
export const removedBarSizeVariable = "";

export default RemoveScroll;
