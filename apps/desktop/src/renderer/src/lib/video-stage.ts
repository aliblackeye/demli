/**
 * Video-stage model — RE-EXPORT ONLY.
 *
 * The model moved to `@demli/media/stage` (ADR 0022): tile construction, the
 * grid↔focus resolution, the speaker-driven filmstrip rule and the grid geometry
 * solver are call-lifecycle logic that mobile has to share, not desktop chrome.
 * Keeping this file as a thin re-export means the renderer's existing imports
 * (`../lib/video-stage`) keep working and there is exactly ONE implementation to
 * change when the layout behaviour changes.
 *
 * Do not add logic here. New stage behaviour belongs in `packages/media/src/stage.ts`
 * so the phone gets it in the same commit.
 */

export type {
  BuildTilesInput,
  CameraSource,
  GridShape,
  ResolveStageOptions,
  SpeakerFilmstripPolicy,
  StageLayout,
  StageSize,
  StageTile,
} from "@demli/media";
export {
  buildTiles,
  cameraKey,
  computeGridShape,
  isScreenTile,
  isTheaterTile,
  LOCAL_CAMERA_KEY,
  LOCAL_SCREEN_KEY,
  participantKey,
  resolveStage,
  screenKey,
  SPEAKER_FILMSTRIP_MIN_OTHERS,
  tileGradient,
  tileHue,
  tileIdentity,
  WATCH_KEY,
} from "@demli/media";
