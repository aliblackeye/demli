/**
 * Is there any video worth putting on the SERVER voice-room stage? Drives the
 * server center's chat-vs-stage choice (AppShell.ServerCenter) and the VoicePanel
 * "return to view" affordance. A live remote camera or screen-share, our own
 * camera, or OUR OWN screen-share all count — the local share now always
 * self-previews as a grid tile (founder #2), so sharing alone brings up the stage.
 *
 * Lives here (not in VideoStage) so non-stage components can read it without
 * pulling in the whole stage component graph — it is a voice/stage selector, not
 * part of the component.
 *
 * SCOPED TO SERVER VOICE (founder P0 crash fix): a live 1-1 DM call renders its
 * OWN VideoStage — embedded in its DM conversation (EmbeddedCallStage, task #104).
 * Those LiveKit tracks must NOT ALSO feed the server-surface stage. Before this
 * guard, a video DM call flipped `hasVideo` true engine-wide, so on a server
 * surface `ServerCenter` mounted a SECOND VideoStage over the SAME MediaStreamTracks:
 * every remote camera/screen track got double-attached and the DM call painted as
 * a bogus "server voice" session ("saçma sapan şeyler") before the renderer fell
 * over. The engine is single-session, so while a DM call owns the surface there is
 * never a competing legit server voice session to stage.
 * A SEAMLESS UPGRADE flips the surface to "group" (media stays on the same room,
 * ADR 0012 §6) — that IS a real server session again, so it is deliberately NOT
 * suppressed and the group call's stage shows normally.
 */

import { isCallLive } from "@demli/client-core";
import {
  useRemoteCameras,
  useRemoteScreenShares,
  useVoiceStore,
} from "../stores/voice-store";
import { useCallState } from "../lib/call-controller";

export function useHasStageVideo(): boolean {
  const shares = useRemoteScreenShares();
  const cameras = useRemoteCameras();
  const cameraEnabled = useVoiceStore((s) => s.cameraEnabled);
  const screenShareEnabled = useVoiceStore((s) => s.screenShareEnabled);
  const callState = useCallState();

  // A live DM call owns its embedded stage — its video is NOT server-stage video.
  // Only a still-DM surface is suppressed; a post-upgrade "group" surface falls
  // through and stages as a real server call.
  const dmCallOwnsSurface = callState.surface?.kind === "dm" && isCallLive(callState);
  if (dmCallOwnsSurface) return false;

  return shares.length > 0 || cameras.length > 0 || cameraEnabled || screenShareEnabled;
}
