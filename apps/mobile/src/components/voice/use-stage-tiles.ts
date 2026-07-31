/**
 * The mobile app's ONE stage-tile builder (call-ux-plan W3).
 *
 * WHY THIS EXISTS. The server voice room and the DM call each grew their OWN
 * copy-pasted tile memo — 18 identical lines in `VoiceRoomScreen` and another 18
 * in `InCallView` (plan §1.1). Two copies of "who is on the stage" is exactly how
 * the two surfaces drifted apart on the phone while the media layer underneath
 * them stayed single (one engine, one FSM, one token path), which is what the
 * founder actually felt as "sunucudaki sesli ile özel arasında fark olmamalıydı".
 * This hook is that logic, once.
 *
 * IT DOES NOT REIMPLEMENT THE MODEL — it CONSUMES `buildTiles` from
 * `@demli/media` (ADR 0022), the same pure model the desktop stage runs on. So
 * tile ORDER, the identity→camera match, and the STABLE tile keys are decided in
 * one shared place for both platforms and both surfaces; this file only joins the
 * result to the mobile roster (name/avatar) and to the RN track objects.
 *
 * WHAT IS DELIBERATELY PASSED EMPTY. `shares`, `localScreenTrack` and
 * `watchChannelId` are left empty even though the shared model supports them.
 * On desktop a screen share and a watch party are TILES IN THE SAME GRID; on a
 * phone they are their own full-bleed stages (`ScreenShareStage`,
 * `WatchPartyStage`) because a 6" portrait screen cannot show a shared desktop
 * and a face grid at once and stay legible. So mobile consumes the model's
 * PARTICIPANT half and keeps its own stage switch above it. The shared keys still
 * line up, so a later wave can fold the two together without re-deriving tiles.
 *
 * REFERENTIAL DISCIPLINE (§27). A media track is not React state: tracks are
 * passed through by stable reference and never rebuilt here, so an active-speaker
 * tick re-renders only the one memoized tile whose `speaking`/`muted` changed.
 */
import { useMemo } from "react";
import { buildTiles, type StageTile } from "@demli/media";
import type { UserId } from "@demli/types";
import { useLocalCameraTrack, useRemoteCameras, useVoiceStore } from "@/stores/voice-store";
import type { ParticipantTileData } from "./ParticipantTile";

export interface MobileStage {
  /**
   * The shared model's participant tiles, in stage order. Carries the STABLE
   * `key` the K3 filmstrip rule (`resolveStage`) resolves against — the reason
   * this is exposed alongside the flat render list.
   */
  stageTiles: StageTile[];
  /** The flat render list, same order — what grids/filmstrips/overlays map over. */
  tiles: ParticipantTileData[];
  /** Render data by shared tile key, for consumers that resolve a layout first. */
  tileByKey: ReadonlyMap<string, ParticipantTileData>;
  /** The local user's identity, or null when we are not in a room. */
  selfIdentity: string | null;
}

/** Resolve a display name and photo for a participant (roster-aware, per surface). */
export interface StageIdentityResolvers {
  nameFor: (userId: UserId) => string;
  avatarFor: (userId: UserId) => string | null;
}

/**
 * Build the live participant stage for whichever room this surface is showing —
 * a server voice channel or a DM call. Both call this; there is no second copy.
 */
export function useStageTiles({ nameFor, avatarFor }: StageIdentityResolvers): MobileStage {
  const participants = useVoiceStore((s) => s.participants);
  const cameraEnabled = useVoiceStore((s) => s.cameraEnabled);
  const remoteCameras = useRemoteCameras();
  const localCameraTrack = useLocalCameraTrack();

  // Local user first. The engine already orders the roster this way, but the
  // shared builder iterates whatever it is given, so the guarantee is made
  // explicit here rather than inherited by luck.
  const ordered = useMemo(() => {
    const local = participants.find((p) => p.isLocal);
    const remotes = participants.filter((p) => !p.isLocal);
    return local ? [local, ...remotes] : remotes;
  }, [participants]);

  const stageTiles = useMemo(
    () =>
      buildTiles({
        participants: ordered,
        remoteCameras,
        cameraEnabled,
        // See the file header: mobile stages shares and watch parties separately.
        shares: [],
        localScreenTrack: null,
        watchChannelId: null,
        // RN surfaces the local camera as a live track object rather than by
        // device id, so the device selector the desktop uses has nothing to say
        // here; the track itself is joined in below.
        selectedVideoDeviceId: null,
      }).filter((tile) => tile.kind === "participant"),
    [ordered, remoteCameras, cameraEnabled],
  );

  return useMemo(() => {
    const tiles: ParticipantTileData[] = [];
    const tileByKey = new Map<string, ParticipantTileData>();
    let selfIdentity: string | null = null;

    for (const tile of stageTiles) {
      if (tile.kind !== "participant") continue;
      const p = tile.participant;
      if (p.isLocal) selfIdentity = p.identity;
      const data: ParticipantTileData = {
        identity: p.identity,
        userId: p.userId,
        name: nameFor(p.userId),
        avatarUrl: avatarFor(p.userId),
        isLocal: p.isLocal,
        muted: !p.micEnabled,
        speaking: p.speaking,
        // Per-user "User Volume" (0..2) — drives the tile's "muted for you" glyph.
        volume: p.volume,
        // The shared model decides WHETHER a camera is on (so turning yours off
        // can never leave a ghost self-preview attached); mobile supplies the
        // actual RN track object for the local self-preview.
        track: p.isLocal
          ? tile.camera
            ? localCameraTrack ?? null
            : null
          : tile.camera?.kind === "camera-remote"
            ? tile.camera.camera.track
            : null,
      };
      tiles.push(data);
      tileByKey.set(tile.key, data);
    }

    return { stageTiles, tiles, tileByKey, selfIdentity };
  }, [stageTiles, localCameraTrack, nameFor, avatarFor]);
}
