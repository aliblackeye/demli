/**
 * Pure model for the call/voice-room VIDEO STAGE — tile construction, the
 * grid↔focus layout state machine, the speaker-driven filmstrip rule (K3) and the
 * grid geometry solver. No React, no DOM element handling, no livekit import: it
 * is RN-safe like the rest of this package's root entry.
 *
 * WHY IT LIVES HERE (ADR 0022). This model used to be desktop-only
 * (`apps/desktop/.../lib/video-stage.ts`) while mobile grew its own copy-pasted
 * tile builders in two screens — which is exactly how the DM call and the server
 * voice room drifted apart on the phone (plan §1.1/§1.3). "What is on the stage"
 * is call-lifecycle logic, not chrome, so it belongs next to the voice FSM where
 * one change reaches both platforms and both surfaces at once. The desktop file
 * is now a re-export.
 *
 * The stage is a UNIFIED participant grid: EVERY voice
 * participant is an equal tile whether their camera is on or off. A tile with a
 * live camera shows video; a tile without one shows an identity-hued avatar.
 * Screen shares are their own tiles. Each tile carries a STABLE opaque key so the
 * view layer can point at one with a single knob (a focus key) instead of
 * scattering booleans (CLAUDE.md §11/§23).
 *
 * "What's on the stage" is DERIVED here from the live tiles + the focus key,
 * never stored — a key that no longer resolves simply falls back to the default.
 */

import type { ChannelId } from "@demli/types";
import type { RemoteCamera, RemoteScreenShare } from "./engine.js";
import type { VoiceParticipant } from "./state.js";

/** Stable key for the local self-preview (there is only ever one). */
export const LOCAL_CAMERA_KEY = "camera:local";
/** Stable key for the local screen-share self-preview (only ever one). */
export const LOCAL_SCREEN_KEY = "screen:local";
/** Stable key for the watch-party tile (one session per voice channel, ADR 0016). */
export const WATCH_KEY = "watch";
export const screenKey = (identity: string): string => `screen:${identity}`;
export const cameraKey = (identity: string): string => `camera:${identity}`;
export const participantKey = (identity: string): string => `participant:${identity}`;

/** A measured box. Structural on purpose — the view layer measures, we solve. */
export interface StageSize {
  width: number;
  height: number;
}

/**
 * The attachable camera VIDEO for a participant — a remote track or the local
 * self-preview. `null` on a participant tile means "camera off" (render the
 * avatar instead). A discriminated union so the tile renderer picks the local vs
 * remote component without another lookup.
 */
export type CameraSource =
  | { kind: "camera-remote"; key: string; camera: RemoteCamera }
  | { kind: "camera-local"; key: typeof LOCAL_CAMERA_KEY; deviceId: string | null };

/**
 * One grid/stage tile. Every participant is a tile (camera shown when on, avatar
 * otherwise); every screen-share is its own tile. The local screen self-preview
 * is a "local-screen" tile carrying the raw capture track — the view renders it
 * from the track directly instead of a LiveKit `track.attach`.
 */
export type StageTile =
  | {
      kind: "participant";
      key: string;
      participant: VoiceParticipant;
      /** The participant's live camera, or null when their camera is off. */
      camera: CameraSource | null;
    }
  | { kind: "screen"; key: string; share: RemoteScreenShare }
  | { kind: "local-screen"; key: typeof LOCAL_SCREEN_KEY; track: MediaStreamTrack }
  /**
   * A running watch party (M20, ADR 0016). Carries only the CHANNEL — never the
   * session — so the 5 s sync heartbeat cannot churn this array and re-render the
   * whole stage; the player subscribes to the session itself (§27).
   */
  | { kind: "watch"; key: typeof WATCH_KEY; channelId: ChannelId };

/**
 * True for any screen tile (remote share or the local self-preview). These are
 * the tiles that enable share-only stage chrome ONCE ON THE STAGE
 * (fullscreen-on-double-click, collapse cameras, pin a camera to the overlay).
 * NB: only a REMOTE screen AUTO-takes the stage (see resolveStage); the local
 * self-preview reaches the stage only when the sharer clicks it to focus.
 */
export function isScreenTile(tile: StageTile | null): boolean {
  return tile?.kind === "screen" || tile?.kind === "local-screen";
}

/**
 * True for the tiles that are "something being watched" rather than a face — a
 * screen share or a watch party. These are what the theatre chrome keys off:
 * double-click to fullscreen and the pin-a-camera-to-the-overlay action both make
 * sense over a film and make no sense over somebody's webcam.
 */
export function isTheaterTile(tile: StageTile | null): boolean {
  return isScreenTile(tile) || tile?.kind === "watch";
}

/** The identity a participant tile belongs to, or null for a non-participant tile. */
export function tileIdentity(tile: StageTile): string | null {
  if (tile.kind === "participant") return tile.participant.identity;
  if (tile.kind === "screen") return tile.share.identity;
  return null;
}

export interface BuildTilesInput {
  /** The voice roster (the engine puts the local user first). */
  participants: readonly VoiceParticipant[];
  /** Live remote camera tracks, matched to participants by identity. */
  remoteCameras: readonly RemoteCamera[];
  /** Live remote screen shares. */
  shares: readonly RemoteScreenShare[];
  /** Whether the LOCAL user's camera is publishing (self-preview source). */
  cameraEnabled: boolean;
  /** Selected local camera device (null = platform default). */
  selectedVideoDeviceId: string | null;
  /**
   * The LOCAL screen-share track to self-preview, or null when not sharing. When
   * present it becomes a "local-screen" tile — placed FIRST so YOUR broadcast
   * leads the tile order. It does NOT auto-take the stage; it is a normal grid
   * tile you click to focus, just like a camera (see resolveStage).
   */
  localScreenTrack: MediaStreamTrack | null;
  /**
   * The voice channel with a RUNNING watch party, or null. Just the id: the
   * session state lives in the watch store and is read by the player, so a
   * heartbeat never reaches this function (§27).
   */
  watchChannelId?: ChannelId | null;
}

/**
 * Build the ordered tile list: the watch party (if any), then screen-shares, then
 * every participant (local first) with their matched camera, if any. A remote
 * participant's camera is looked up by identity; the local user's camera is the
 * self-preview source when `cameraEnabled`.
 */
export function buildTiles(input: BuildTilesInput): StageTile[] {
  const { participants, remoteCameras, shares, cameraEnabled, selectedVideoDeviceId } = input;
  const camerasByIdentity = new Map(remoteCameras.map((c) => [c.identity, c]));

  const tiles: StageTile[] = [];
  // The party leads the order and (see resolveStage) owns the stage outright
  // while it runs — it is the thing the room came for.
  if (input.watchChannelId) {
    tiles.push({ kind: "watch", key: WATCH_KEY, channelId: input.watchChannelId });
  }
  // Your own broadcast leads the tile order so it is the first grid tile the
  // moment you share — but it does NOT auto-take the stage; it is a normal grid
  // tile you click to focus, exactly like a camera (see resolveStage).
  if (input.localScreenTrack) {
    tiles.push({ kind: "local-screen", key: LOCAL_SCREEN_KEY, track: input.localScreenTrack });
  }
  for (const share of shares) {
    tiles.push({ kind: "screen", key: screenKey(share.identity), share });
  }
  for (const participant of participants) {
    let camera: CameraSource | null = null;
    if (participant.isLocal) {
      if (cameraEnabled) {
        camera = { kind: "camera-local", key: LOCAL_CAMERA_KEY, deviceId: selectedVideoDeviceId };
      }
    } else {
      const remote = camerasByIdentity.get(participant.identity);
      if (remote) {
        camera = { kind: "camera-remote", key: cameraKey(remote.identity), camera: remote };
      }
    }
    tiles.push({ kind: "participant", key: participantKey(participant.identity), participant, camera });
  }
  return tiles;
}

/**
 * Below this many CONDITIONAL participants (non-stage, non-self) the speaker rule
 * does not apply and every tile stays in the filmstrip — so with a pin it engages
 * from a five-person room upward.
 *
 * The rule exists to stop a crowded room from pulling (and drawing) a dozen
 * simultaneous camera streams next to a pinned one. In a 1-1 or 1-2 call there is
 * no crowd to thin: hiding the only other person in the call until they happen to
 * make a noise is disorienting and saves nothing measurable. So the rule turns on
 * exactly where the problem it solves starts to exist.
 */
export const SPEAKER_FILMSTRIP_MIN_OTHERS = 3;

/**
 * Inputs for the speaker-driven filmstrip rule (K3). Pass it to keep a pinned
 * stage's companion strip to "me, the screens, and whoever is actually talking";
 * omit it to show every non-stage tile (the pre-K3 behaviour).
 */
export interface SpeakerFilmstripPolicy {
  /**
   * Recency-ordered identities that count as recently active — feed it
   * `ActiveSpeakerSnapshot.recent` from {@link ./active-speaker.js}, which already
   * applies the 300 ms attack / 5 s release hysteresis and the ceiling. Passing a
   * momentary `speaking` flag list here instead would strobe the strip.
   */
  recentSpeakers: readonly string[];
  /**
   * The local user's identity. Their tile is ALWAYS kept — you must be able to
   * see your own state without earning it by talking.
   */
  selfIdentity: string | null;
  /** Override the small-call escape hatch (see SPEAKER_FILMSTRIP_MIN_OTHERS). */
  minOthers?: number;
}

export interface StageLayout {
  /**
   * "grid": no single stage — every participant shown in an equal grid (the
   * default when nobody is screen-sharing and nothing is focused).
   * "focus": one tile is the large stage, the rest form the filmstrip.
   */
  mode: "grid" | "focus";
  /** The stage tile in focus mode (null in grid mode). */
  stage: StageTile | null;
  /**
   * The non-stage tiles to RENDER in focus mode (empty in grid mode). With a
   * {@link SpeakerFilmstripPolicy} this is already filtered to self + screens +
   * recent speakers; tiles missing from it must be UNMOUNTED, not merely hidden,
   * so adaptiveStream/dynacast stop pulling their video (K3 subscription policy).
   */
  filmstrip: StageTile[];
  /**
   * Participant tiles the speaker rule is withholding from the filmstrip right
   * now. The view shows this as a count ("+3") so the room's size stays legible
   * even when most of it is quiet — a hidden participant must never read as an
   * absent one.
   */
  hiddenBySpeakerRule: StageTile[];
  /** Participant tiles for grid mode (empty in focus mode). */
  grid: StageTile[];
  /** All camera sources, in order — used by the stage overlay's camera picker. */
  cameras: CameraSource[];
  /**
   * True when the stage cannot be changed by clicking another tile — currently
   * only while a watch party runs (see resolveStage). The view uses it to
   * WITHHOLD the focus affordances rather than render clicks that do nothing (§35).
   */
  locked: boolean;
}

export interface ResolveStageOptions {
  /** The explicitly pinned tile key, or null for the default stage. */
  focusedKey: string | null;
  /** Apply the K3 speaker filmstrip rule. Omit to keep every non-stage tile. */
  speakerFilmstrip?: SpeakerFilmstripPolicy;
}

/**
 * Split the non-stage tiles into what the filmstrip renders and what the speaker
 * rule is holding back.
 *
 * ALWAYS kept: every non-participant tile (screen shares, the watch party) and
 * the local user's own tile. CONDITIONAL: every other participant, and only while
 * their identity is in `recentSpeakers` — ordered by that list, i.e. by recency,
 * so the freshest voice sits closest to the stage.
 */
function splitFilmstrip(
  rest: StageTile[],
  policy: SpeakerFilmstripPolicy | undefined,
): { filmstrip: StageTile[]; hidden: StageTile[] } {
  if (!policy) return { filmstrip: rest, hidden: [] };

  const always: StageTile[] = [];
  const conditional: StageTile[] = [];
  for (const tile of rest) {
    if (tile.kind !== "participant") {
      always.push(tile);
      continue;
    }
    if (tile.participant.isLocal || tile.participant.identity === policy.selfIdentity) {
      always.push(tile);
      continue;
    }
    conditional.push(tile);
  }

  const minOthers = policy.minOthers ?? SPEAKER_FILMSTRIP_MIN_OTHERS;
  if (conditional.length < minOthers) {
    return { filmstrip: [...always, ...conditional], hidden: [] };
  }

  const byIdentity = new Map<string, StageTile>();
  for (const tile of conditional) {
    const identity = tileIdentity(tile);
    if (identity !== null) byIdentity.set(identity, tile);
  }

  const shown: StageTile[] = [];
  const shownKeys = new Set<string>();
  for (const identity of policy.recentSpeakers) {
    const tile = byIdentity.get(identity);
    if (!tile || shownKeys.has(tile.key)) continue;
    shown.push(tile);
    shownKeys.add(tile.key);
  }

  return {
    filmstrip: [...always, ...shown],
    hidden: conditional.filter((tile) => !shownKeys.has(tile.key)),
  };
}

/**
 * Resolve the stage layout from the live tiles, the explicit pin and the speaker
 * rule.
 *
 * - A WATCH PARTY owns the stage outright while it runs, ahead of both the
 *   explicit focus and any screen share. Two reasons, and the second is the
 *   important one: the party is what everyone in the room is there for, and the
 *   player is an IFRAME — moving it between the stage slot and the camera panel
 *   would unmount it, tearing down the embed and its handshake and restarting
 *   playback for that viewer every time somebody clicked a webcam. Pinning it to
 *   one slot makes that impossible rather than merely unlikely.
 * - Otherwise an explicit, still-valid `focusedKey` wins → that tile is the stage.
 * - Otherwise a REMOTE screen-share is the default stage (the first — for the
 *   film-night case of one host sharing).
 * - Otherwise there is no single stage → grid mode over every tile. Note YOUR OWN
 *   screen-share (the local self-preview) does NOT auto-take the stage: it sits in
 *   the grid as a normal tile you click to focus, like a camera. The sharer
 *   already sees their screen, so we never force it big unprompted.
 *
 * Automatic "give the stage to whoever is talking" is deliberately NOT here: the
 * stage would change hands mid-sentence all call long. Pin + a speaker-driven
 * filmstrip covers the same need without the churn (K3, rejected alternative).
 */
export function resolveStage(tiles: StageTile[], options: ResolveStageOptions): StageLayout {
  const { focusedKey, speakerFilmstrip } = options;
  const cameras: CameraSource[] = [];
  for (const tile of tiles) {
    if (tile.kind === "participant" && tile.camera) cameras.push(tile.camera);
  }

  const watch = tiles.find((t) => t.kind === "watch") ?? null;
  if (watch) {
    const split = splitFilmstrip(
      tiles.filter((t) => t.key !== watch.key),
      speakerFilmstrip,
    );
    return {
      mode: "focus",
      stage: watch,
      filmstrip: split.filmstrip,
      hiddenBySpeakerRule: split.hidden,
      grid: [],
      cameras,
      locked: true,
    };
  }

  const focused = focusedKey ? (tiles.find((t) => t.key === focusedKey) ?? null) : null;
  // Only a REMOTE share auto-promotes; the local self-preview must be focused first.
  const autoStage = tiles.find((t) => t.kind === "screen") ?? null;
  const stage = focused ?? autoStage;

  if (!stage) {
    // Grid mode: no focus and no remote share. Every tile (participants + your own
    // local screen-share, if any) shows as an equal grid tile — the speaker rule
    // never applies here, because in a grid nothing is competing with a stage.
    return {
      mode: "grid",
      stage: null,
      filmstrip: [],
      hiddenBySpeakerRule: [],
      grid: tiles,
      cameras,
      locked: false,
    };
  }
  const split = splitFilmstrip(
    tiles.filter((t) => t.key !== stage.key),
    speakerFilmstrip,
  );
  return {
    mode: "focus",
    stage,
    filmstrip: split.filmstrip,
    hiddenBySpeakerRule: split.hidden,
    grid: [],
    cameras,
    locked: false,
  };
}

/**
 * Deterministic HUE for a seed (user id) for a cameraless participant tile.
 *
 * SHARED CROSS-PLATFORM CONTRACT — the same integer math as the mobile renderer
 * (`apps/mobile/src/theme/avatar-color.ts` `avatarHue`) so a person's tile is the
 * IDENTICAL colour on desktop and phone. Pure 32-bit integer math (Java
 * String.hashCode style) with a NON-NEGATIVE mathematical modulo — note
 * `((hash % 360) + 360) % 360`, NOT `Math.abs(hash) % 360`; the two disagree for
 * negative hashes, so this must stay exactly as mobile has it.
 */
export function tileHue(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return ((hash % 360) + 360) % 360;
}

/**
 * Colored two-stop gradient backdrop for a cameraless participant tile — the
 * "camera off" look. Hue + saturation/lightness stops are the mobile contract's
 * exact tunables (SAT_TOP 55 / LIGHT_TOP 30 → HUE_SHIFT 16, SAT_BOTTOM 60 /
 * LIGHT_BOTTOM 18), rendered top→bottom (180deg) like the mobile SVG. Dark,
 * mid-saturation so the dark-first shell stays calm and white initials read on top.
 */
export function tileGradient(seed: string): string {
  const hue = tileHue(seed);
  const from = `hsl(${hue}, 55%, 30%)`;
  const to = `hsl(${(hue + 16) % 360}, 60%, 18%)`;
  return `linear-gradient(180deg, ${from} 0%, ${to} 100%)`;
}

export interface GridShape {
  cols: number;
  rows: number;
  /**
   * When true the best fit would make tiles smaller than `minTile`, so the grid
   * uses a fixed column count and SCROLLS vertically instead of shrinking further.
   */
  scroll: boolean;
}

/**
 * Choose the column/row split that makes the largest equal 16:9 tile for `count`
 * tiles inside the measured container. This is what makes the grid responsive to
 * BOTH the participant count and the window shape: a wide window puts two people
 * side by side, a tall/narrow one stacks them, 3–4 land in a 2×2, and so on —
 * because the arrangement that maximizes the tile size wins.
 *
 * If even the best arrangement is smaller than `minTile`, we stop shrinking and
 * fall back to a fixed-column SCROLLING grid (many participants).
 */
export function computeGridShape(
  count: number,
  size: StageSize,
  opts?: { aspect?: number; gap?: number; minTile?: number },
): GridShape {
  const aspect = opts?.aspect ?? 16 / 9;
  const gap = opts?.gap ?? 12;
  const minTile = opts?.minTile ?? 200;

  if (count <= 1) return { cols: 1, rows: 1, scroll: false };

  const { width, height } = size;
  if (width <= 0 || height <= 0) {
    // Pre-measure fallback: a roughly square grid until the view reports a size.
    const cols = Math.ceil(Math.sqrt(count));
    return { cols, rows: Math.ceil(count / cols), scroll: false };
  }

  let best = { cols: 1, rows: count, tile: 0 };
  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols);
    const cellW = (width - gap * (cols - 1)) / cols;
    const cellH = (height - gap * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) continue;
    // Largest 16:9 tile that fits the cell = min(cellW, cellH * aspect).
    const tile = Math.min(cellW, cellH * aspect);
    if (tile > best.tile) best = { cols, rows, tile };
  }

  if (best.tile < minTile) {
    const cols = Math.max(1, Math.floor((width + gap) / (minTile + gap)));
    return { cols, rows: Math.ceil(count / cols), scroll: true };
  }
  return { cols: best.cols, rows: best.rows, scroll: false };
}
