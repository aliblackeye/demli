/**
 * Where the live 1-1 DM call is presented (embedded-call layout, task #104).
 *
 * The DM call no longer takes over a full-screen overlay. Instead it renders
 * EMBEDDED at the top of its own DM conversation (see {@link EmbeddedCallStage})
 * with a bottom-left control dock (see {@link CallDock}). When the
 * user navigates anywhere else, the call keeps running and only the floating
 * {@link CallPill} shows.
 *
 * This selector is the SINGLE source of truth for that "embedded here vs. floating
 * elsewhere" decision, shared by the three surfaces that must agree — the embedded
 * stage, the dock, and the pill — so they can never disagree about which one is on
 * screen. It reads the call FSM (via {@link useCallState}) and the chat navigation
 * store; a post-upgrade GROUP surface is intentionally NOT an embedded-DM surface
 * (CallLayer routes those into the server surface, ADR 0012 §6).
 */

import type { DmId } from "@demli/types";
import type { CallState } from "@demli/client-core";
import { useCallState } from "../lib/call-controller";
import { useChatStore } from "../stores/chat-store";

export interface DmCallSurface {
  /** The live call FSM state. */
  state: CallState;
  /** A 1-1 DM call is live (ringing-out or active) on a `dm` surface. */
  isDmCall: boolean;
  /** The DM id the live call belongs to, or null when no DM call is live. */
  callDmId: DmId | null;
  /**
   * True when the live DM call's conversation is the one currently open on
   * screen — the embedded stage + dock show; the pill hides. False everywhere
   * else (other DM, friends, a server), where the pill shows instead.
   */
  onCallDm: boolean;
  /**
   * Is this device's media actually IN the call's room (ADR 0023 §1)?
   *
   * False is a normal, showable state now, not a bug: the account can be on this
   * call from a phone (`elsewhere`), or have walked out of the room while the
   * call runs on (`vacant`). Every surface that renders live MEDIA — the video
   * stage, the camera/screen/mic controls — must gate on this, or it offers dead
   * buttons over a room this device is not in (§35).
   */
  seatedHere: boolean;
}

export function useDmCallSurface(): DmCallSurface {
  const state = useCallState();
  const activeView = useChatStore((s) => s.activeView);
  const homeView = useChatStore((s) => s.homeView);
  const activeDmId = useChatStore((s) => s.activeDmId);

  const callDmId = state.surface?.kind === "dm" ? state.surface.dmId : null;
  const isDmCall =
    callDmId !== null && (state.phase === "outgoing" || state.phase === "active");
  const onCallDm =
    isDmCall && activeView === "home" && homeView === "dm" && activeDmId === callDmId;

  return { state, isDmCall, callDmId, onCallDm, seatedHere: state.seat === "here" };
}
