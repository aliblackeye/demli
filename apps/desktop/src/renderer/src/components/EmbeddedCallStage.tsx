/**
 * Embedded 1-1 DM-call stage (task #104 — the founder's DM-call layout: the
 * call sits inside the conversation, not on a separate screen).
 *
 * Rendered at the TOP of the DM conversation it belongs to ({@link DmView}); the
 * DM's messages + composer keep flowing underneath, so you can chat during the
 * call. This REPLACES the old full-screen call overlay: the left sidebar and the
 * chat stay visible and usable throughout the call.
 *
 * INSTANT ROOM (founder directive): starting a call puts you in the room straight
 * away — the caller's `start()` already joins LiveKit while the callee is still
 * ringing, so the stage renders the SAME {@link VideoStage} in both phases and the
 * whole control set is live before anyone answers (camera, screen share, mic,
 * quality — exactly like a voice channel). The ringing state does not disappear; it
 * is a slim badge row ABOVE the stage instead of a blocking "calling…" panel.
 *
 *  - Ringing (outgoing): ringing badge + the live stage (your own tile, your camera,
 *    your screen share — all publishable before the peer picks up).
 *  - Active: the same stage, uninterrupted. The peer's tile simply appears.
 *
 * CRITICAL: `VideoStage` occupies the SAME child slot in both phases, so the
 * outgoing → active transition never remounts it — an open camera / screen share
 * keeps its attached tracks across the answer.
 *
 * The stage is the shared voice-room {@link VideoStage} (participant grid / cameras
 * / screen-share with per-tile focus + fullscreen). Clicking a tile focuses it; the
 * stage's own fullscreen button blows it up to fill the window and back.
 *
 * Self-hiding: it reads {@link useDmCallSurface} and renders nothing unless the
 * call's DM is the one on screen, so DmView can mount it unconditionally without
 * subscribing itself to the call FSM (keeps chat renders off the call ticks, §27).
 *
 * The call CONTROLS (camera / screen-share / hang up) live in the bottom-left
 * {@link CallDock}, not here — this surface is purely the video stage, mirroring
 * the server voice layout (stage in the center, controls in the sidebar).
 */

import { useMemo, useState } from "react";
import { UserAvatar } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";
import { useDms } from "../queries/social-queries";
import { useVideoStageStore } from "../stores/video-stage-store";
import { useDmCallSurface } from "../hooks/useDmCallSurface";
import { VideoStage } from "./VideoStage";
import { StageHeightHandle } from "./StageHeightHandle";

/** Embedded-stage height bounds (px). Default sits ~half the typical window. */
const MIN_HEIGHT = 220;
const MAX_HEIGHT = 560;
const DEFAULT_HEIGHT = 360;

/**
 * Last chosen stage height, kept at module scope so it survives the component
 * unmounting when the user navigates away and comes back (a store would be
 * overkill for one number only this component reads).
 */
let persistedHeight = DEFAULT_HEIGHT;
const clampHeight = (n: number): number =>
  n < MIN_HEIGHT ? MIN_HEIGHT : n > MAX_HEIGHT ? MAX_HEIGHT : n;

export function EmbeddedCallStage(): JSX.Element | null {
  const { t } = useAppTranslation();
  const { state, onCallDm, callDmId, seatedHere } = useDmCallSurface();
  const { data: dms } = useDms();
  // A tile blown up to fullscreen leaves the flow (fixed inset-0), so collapse our
  // reserved height to 0 while it does — the chat beneath stays correct behind the
  // overlay, and nothing remounts (VideoStage keeps the same tree, so its tracks
  // stay attached).
  const fullscreen = useVideoStageStore((s) => s.fullscreen);
  const [height, setHeightState] = useState(persistedHeight);

  const peer = useMemo(() => {
    if (state.peer) return state.peer;
    const dm = (dms ?? []).find((d) => d.id === callDmId);
    return dm?.participant ?? null;
  }, [state.peer, dms, callDmId]);

  // No seat on this device (the call is on the phone, or we walked out) ⇒ no
  // media to stage. The CallDock carries the "bring it here / rejoin" band; an
  // empty participant grid here would just look like a broken call.
  if (!onCallDm || !seatedHere) return null;

  const setHeight = (px: number): void => {
    persistedHeight = clampHeight(px);
    setHeightState(persistedHeight);
  };

  const ringing = state.phase === "outgoing";

  return (
    <section
      aria-label={t("desktop:call.regionLabel")}
      style={{ height: fullscreen ? 0 : height }}
      className="flex shrink-0 flex-col overflow-hidden bg-app"
    >
      {/* Ringing badge — a slim row, never a blocking panel: the room underneath
          stays fully usable while the peer's phone rings. */}
      {ringing && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b border-stroke/70 bg-surface/40 px-4 py-1.5"
        >
          <span className="relative flex size-2 shrink-0" aria-hidden>
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent/70" />
            <span className="relative inline-flex size-2 rounded-full bg-accent" />
          </span>
          <UserAvatar
            name={peer?.displayName ?? "?"}
            colorSeed={peer?.id ?? callDmId ?? "call"}
            src={peer?.avatarUrl ?? null}
            size="xs"
          />
          <p className="truncate text-xs font-semibold text-fg">
            {peer?.displayName ?? t("desktop:call.calling")}
          </p>
          <p className="shrink-0 text-xs text-fg-muted">{t("desktop:call.ringing")}</p>
          <p className="ml-auto hidden truncate text-2xs text-fg-faint sm:block">
            {t("desktop:call.ringingStageHint")}
          </p>
        </div>
      )}

      {/* The shared voice-room stage fills the remaining reserved height, in BOTH
          phases (same slot → no remount when the call is answered). It is
          `min-h-0 flex-1` internally, so it fits our bounded box (and goes
          `fixed inset-0` on its own when fullscreen). */}
      <VideoStage />

      {!fullscreen && (
        <StageHeightHandle
          ariaLabel={t("desktop:call.resizeStage")}
          heightPx={height}
          minPx={MIN_HEIGHT}
          maxPx={MAX_HEIGHT}
          onResize={setHeight}
        />
      )}
    </section>
  );
}
