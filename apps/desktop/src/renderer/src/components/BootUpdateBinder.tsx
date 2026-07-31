/**
 * Headless driver for the startup-update flow.
 *
 * Renders nothing. It is the only place the pure machine in lib/boot-update.ts
 * meets the outside world:
 *
 *   in   main's UpdateStatus (via the single bridge subscription in
 *        lib/update-status.ts) + a clock pulse
 *   out  `downloadAndInstall()` over the existing, state-guarded IPC, and the
 *        `"update"` boot phase in stores/boot-store.ts
 *
 * No new IPC channel exists for any of this: starting the download and applying
 * it are exactly the two things the top-right UpdateBadge already does, so main's
 * guards (and its security posture) are unchanged.
 *
 * Mounted from AppRoot next to the splash — i.e. only when the renderer really
 * loads. That is what makes this a COLD-START flow and nothing else: restoring
 * the window from the tray does not reload the renderer, so this never re-runs
 * there (close-to-tray means the X is not a quit — see main/system.ts).
 */

import { useEffect } from "react";
import type { BootUpdateEvent } from "../lib/boot-update";
import { isDesktopSurface } from "../lib/surface";
import {
  downloadOrInstall,
  useUpdateStatus,
  useUpdateStatusSeeded,
} from "../lib/update-status";
import { useBootStore } from "../stores/boot-store";
import { useBootUpdateStore } from "../stores/boot-update-store";

/**
 * Deadline resolution. The tightest thing it has to land on is the 1.2s
 * "applying" notice, so four pulses a second is plenty — and a tick that changes
 * nothing returns the identical state object, so it costs no render.
 */
const TICK_MS = 250;

/**
 * Advance the machine and carry out whatever it asked for.
 *
 * `release` is the important one: it is the ONLY way the flow lets the splash
 * finish, and it always ends the `"update"` phase.
 *   - dropped   when this boot never had an update to install, so the progress
 *               bar's denominator goes back to the five ordinary phases and the
 *               splash is byte-for-byte what it is today;
 *   - degraded  when we did engage and had to give up, because that is the
 *               store's honest word for "it finished without succeeding".
 */
function run(event: BootUpdateEvent): void {
  for (const effect of useBootUpdateStore.getState().dispatch(event)) {
    switch (effect.type) {
      case "start-download":
      case "apply":
        // Same call for both: main resolves it from ITS state — from `available`
        // it downloads, from `ready` it installs and relaunches. A renderer can
        // never force an unexpected restart (main/auto-update.ts).
        downloadOrInstall();
        break;
      case "release":
        if (effect.reason !== "up-to-date" && effect.reason !== "unsupported") {
          console.info(`[boot-update] released: ${effect.reason}`);
        }
        if (effect.engaged) {
          useBootStore.getState().degradeBootPhase("update");
        } else {
          useBootStore.getState().dropBootPhases("update");
        }
        break;
    }
  }
}

export function BootUpdateBinder(): null {
  const status = useUpdateStatus();
  const seeded = useUpdateStatusSeeded();
  const stage = useBootUpdateStore((s) => s.state.stage);
  const bootDone = useBootStore((s) => s.status === "done");

  // Arm on mount. `arm` is idempotent in the reducer, so StrictMode's double
  // mount in dev does not restart the clock.
  useEffect(() => {
    run({ type: "arm", at: Date.now(), supported: isDesktopSurface() });
  }, []);

  // Only forward a status main has genuinely reported — the store's placeholder
  // is `disabled`, which would otherwise end the flow before it began.
  useEffect(() => {
    if (!seeded) return;
    run({ type: "status", at: Date.now(), status });
  }, [seeded, status]);

  // The clock. Runs only while something is actually being waited on.
  useEffect(() => {
    if (stage === "idle" || stage === "released") return;
    const timer = window.setInterval(() => run({ type: "tick", at: Date.now() }), TICK_MS);
    return () => window.clearInterval(timer);
  }, [stage]);

  // Someone else finished the boot (the splash's own ceiling, or the crash
  // fallback in AppRoot). Stand down rather than quitting an app that is already
  // on screen — the badge takes the update from here.
  useEffect(() => {
    if (!bootDone) return;
    run({ type: "abandon", at: Date.now() });
  }, [bootDone]);

  return null;
}
