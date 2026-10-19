/**
 * PlatformBridge — the typed contract the shared product UI talks to instead of
 * reaching for `window.demli` (desktop) or browser globals (web) directly.
 *
 * It MIRRORS, 1:1, the namespaces the desktop preload exposes on
 * `window.demli` (apps/desktop/src/preload/index.ts + the `*-types.ts`
 * modules under apps/desktop/src/main). The shapes are copied here — NOT
 * imported — on purpose: a shared package must never depend on an app
 * (architecture rule; the dependency arrow only points app -> package). Because
 * these interfaces are structurally identical to the desktop `DemliBridge`,
 * the desktop can pass its `window.demli` straight into
 * `createDesktopBridge` / `<PlatformProvider>` and it type-checks as a
 * `PlatformBridge` with no cast.
 *
 * PHASE-1 NOTE: if these ever drift from the desktop `*-types.ts` source of
 * truth, the desktop wiring stops compiling — that is the intended tripwire.
 * A later refactor may hoist the desktop contract types into a shared package
 * and have both sides import them; until then, keep this file in lockstep.
 *
 * Pure TypeScript types only — no runtime, no React, no DOM/Electron/Node
 * imports.
 */

/* ── 1. appInfo ─────────────────────────────────────────────────────────── */

/**
 * Build/runtime identity. `platform` is intentionally the WIDE `string` type
 * (supertype of the desktop's `NodeJS.Platform` union and the web adapter's
 * literal `"web"`), so both platforms' concrete values are assignable here.
 */
export interface AppInfo {
  /** App/package version string. */
  version: string;
  /** Coarse surface id: a Node platform ("win32", "darwin", …) or "web". */
  platform: string;
}

/* ── 2. capture (screen/window capture) ─────────────────────────────────── */

export type CaptureSourceKind = "screen" | "window";

/** Minimal, sanitized description of a capturable source for an in-app picker. */
export interface CaptureSource {
  /** Opaque source id, e.g. "screen:0:0" or "window:12345:0". */
  id: string;
  /** Human-readable label: monitor name or window title. */
  name: string;
  kind: CaptureSourceKind;
  /** Small PNG data URL for the picker grid; "" when none is available. */
  thumbnailDataUrl: string;
  /** Optional app-icon data URL (reserved; may be absent). */
  appIconDataUrl?: string;
}

/** Options passed when enumerating sources. */
export interface ListSourcesOptions {
  /** Desired thumbnail width in px (the provider clamps to a safe range). */
  maxThumbnailWidth?: number;
}

/**
 * Request to arm the source served by the NEXT getDisplayMedia() call. Always
 * served as video only; share sound comes from {@link ProcessAudioBridge}.
 */
export interface CaptureSelectionRequest {
  /** Must equal the id of a source returned by a prior listSources() call. */
  sourceId: string;
}

/** Result of arming a selection. */
export interface CaptureSelectionResult {
  ok: true;
  sourceId: string;
}

/** Notification emitted right after a source is served to the media engine. */
export interface DisplaySourceServedEvent {
  sourceId: string;
}

export interface CaptureBridge {
  /** Enumerate capturable screens/windows for an in-app picker. */
  listSources(options?: ListSourcesOptions): Promise<CaptureSource[]>;
  /** Arm the source the next getDisplayMedia() call will receive (single-shot). */
  selectSource(request: CaptureSelectionRequest): Promise<CaptureSelectionResult>;
  /** Discard any armed selection. */
  clearSelection(): Promise<void>;
  /** Subscribe to "a source was served"; returns an unsubscribe function. */
  onDisplaySourceServed(listener: (event: DisplaySourceServedEvent) => void): () => void;
}

/* ── 3. processAudio (Windows per-process loopback) ─────────────────────── */

/** PCM wire format emitted by the capture helper and rebuilt into a track. */
export interface ProcessAudioFormat {
  sampleRate: number;
  channels: number;
  bitDepth: number;
}

/** Which process tree a capture follows: one app ("app") or all but Demli ("system"). */
export type ProcessAudioMode = "app" | "system";

/** Request to start a process-audio capture. "app" names a `window:` source
 *  from a prior capture.listSources(); "system" always excludes Demli itself. */
export type ProcessAudioStartRequest =
  | { mode: "app"; sourceId: string }
  | { mode: "system" };

/** Why a capture cannot run (never fatal to the share). */
export type ProcessAudioUnavailableReason =
  | "unsupported_platform"
  | "unsupported_os"
  | "not_a_window"
  | "unknown_source"
  | "pid_unresolved"
  | "includes_demli"
  | "binary_missing"
  | "spawn_failed"
  | "activation_failed";

/** Whether process capture can work on this machine. */
export type ProcessAudioSupport =
  | { supported: true }
  | { supported: false; reason: "unsupported_platform" | "unsupported_os" | "binary_missing" };

/** Result of a start request. */
export type ProcessAudioStartResult =
  | { ok: true; captureId: number; mode: ProcessAudioMode; format: ProcessAudioFormat }
  | { ok: false; reason: ProcessAudioUnavailableReason };

/** A raw PCM chunk for an active capture. */
export interface ProcessAudioChunk {
  captureId: number;
  chunk: Uint8Array;
}

/** Notification that a capture ended. */
export interface ProcessAudioEndedEvent {
  captureId: number;
  reason: string;
}

export interface ProcessAudioBridge {
  support(): Promise<ProcessAudioSupport>;
  start(request: ProcessAudioStartRequest): Promise<ProcessAudioStartResult>;
  stop(captureId: number): Promise<void>;
  onData(listener: (chunk: ProcessAudioChunk) => void): () => void;
  onEnded(listener: (event: ProcessAudioEndedEvent) => void): () => void;
}

/* ── 4. secureToken — the TokenStorage seam (ADR 0002) ──────────────────── */

/** Async single-value string slot for the session token. */
export interface SecureTokenBridge {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

/* ── 5. secureVault — the VaultStorage seam (ADR 0013, multi-account) ────── */

/** Async single-value string slot for the multi-account vault blob. */
export interface SecureVaultBridge {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}

/* ── 6. crash (report-only) ─────────────────────────────────────────────── */

/** A structured renderer-side error report (message required, stacks optional). */
export interface RendererErrorReport {
  message: string;
  stack?: string;
  componentStack?: string;
}

export interface CrashBridge {
  reportRendererError(report: RendererErrorReport): Promise<void>;
}

/* ── 7. updates (auto-update lifecycle) ─────────────────────────────────── */

/** Which operation failed — a machine code the UI localizes. */
export type UpdateErrorScope = "check" | "download";

/** The update lifecycle as a discriminated union. */
export type UpdateStatus =
  | { kind: "disabled" }
  | { kind: "checking" }
  | { kind: "up-to-date"; version: string }
  | { kind: "available"; version: string; critical: boolean }
  | { kind: "downloading"; version: string; percent: number; critical: boolean }
  | { kind: "ready"; version: string; critical: boolean }
  | { kind: "error"; scope: UpdateErrorScope };

export type UpdateStatusKind = UpdateStatus["kind"];

export interface UpdatesBridge {
  check(): Promise<UpdateStatus>;
  getStatus(): Promise<UpdateStatus>;
  onStatus(listener: (status: UpdateStatus) => void): () => void;
  downloadAndInstall(): Promise<void>;
}

/* ── 8. system (tray + launch-at-startup) ───────────────────────────────── */

/** User-controllable desktop-system preferences. */
export interface DesktopSystemSettings {
  /** Clicking X hides to tray instead of quitting (default true on desktop). */
  closeToTray: boolean;
  /** Register as a login item and start on sign-in (default false). */
  autoLaunch: boolean;
}

/**
 * The user's own voice state, as the system tray shows it. A read-only
 * projection of the voice engine state (packages/media, CLAUDE.md §11) — never a
 * second state model.
 */
export interface TrayVoiceStatus {
  /** In a voice channel OR a DM call (both drive the same engine). */
  inVoiceSession: boolean;
  /** Mic on. Only meaningful while `inVoiceSession`. */
  micEnabled: boolean;
  /** Deafened. Only meaningful while `inVoiceSession`. Implies `!micEnabled`. */
  deafened: boolean;
}

export interface SystemBridge {
  getSettings(): Promise<DesktopSystemSettings>;
  setCloseToTray(enabled: boolean): Promise<DesktopSystemSettings>;
  setAutoLaunch(enabled: boolean): Promise<DesktopSystemSettings>;
  /**
   * Reflect unread notifications on the tray icon (red dot) + the Windows taskbar
   * overlay. Transient; call on every 0↔n crossing.
   */
  setUnreadBadge(hasUnread: boolean): Promise<void>;
  /**
   * Reflect the user's own voice state on the tray icon (normal / muted mic /
   * deafened). Transient; call only on a real change — the voice store ticks
   * continuously during a call and each call repaints a native icon.
   */
  setVoiceStatus(status: TrayVoiceStatus): Promise<void>;
}

/* ── 9. notifications (native toast + click-to-navigate) ────────────────── */

/** Where a click on a notification should take the user. */
export type NotificationNavigate =
  | { target: "channel"; groupId: string; channelId: string }
  | { target: "groupChat"; groupChatId: string; streamId: string }
  | { target: "dm"; dmId: string; streamId: string }
  | { target: "friends" }
  | { target: "update" }
  | { target: "call" };

/** A single notification request (title/body are plain text — no HTML). */
export interface NotificationRequest {
  title: string;
  body: string;
  navigate: NotificationNavigate;
}

export interface NotificationsBridge {
  notify(request: NotificationRequest): Promise<void>;
  onActivated(listener: (navigate: NotificationNavigate) => void): () => void;
  requestFocus(): Promise<void>;
}

/* ── 10. images (save / copy a picture shared in chat) ──────────────────── */

/**
 * A request to act on ONE already-visible image.
 *
 * - `url` — the short-lived signed read URL the UI already resolved for the
 *   tile. On desktop main re-validates it against the pinned storage origins
 *   before it fetches anything; on web the browser's own CORS/CSP rules apply.
 * - `mime` — the attachment's declared image MIME (the API's four-image
 *   whitelist: png / jpeg / webp / gif).
 * - `fileName` — a SUGGESTED name. Desktop sanitizes it and offers it in the
 *   native save dialog; the real destination is whatever the user picks. Web
 *   uses it as the download name.
 */
export interface ImageActionRequest {
  url: string;
  mime: string;
  fileName: string;
}

/** Why an image action could not complete (each maps to one localized line). */
export type ImageActionFailure =
  | "blocked_url"
  | "unsupported_type"
  | "download_failed"
  | "too_large"
  | "unsupported_format"
  | "clipboard_failed"
  | "write_failed";

/**
 * Result of a save. `canceled` is a first-class, SILENT outcome: dismissing the
 * dialog is a normal user choice, not an error, and the UI must say nothing.
 */
export type ImageSaveResult =
  | { status: "saved"; fileName: string }
  | { status: "canceled" }
  | { status: "error"; reason: ImageActionFailure };

/** Result of a clipboard copy. */
export type ImageCopyResult =
  | { status: "copied" }
  | { status: "error"; reason: ImageActionFailure };

/**
 * Save / copy for a picture shared in chat.
 *
 * Both flags are SYNCHRONOUS capability booleans, not promises: the UI reads
 * them during render to decide whether each entry exists at all. A surface that
 * cannot perform an action must not show a dead button (CLAUDE.md §35).
 *
 * - `saveSupported` — is the feature usable here at all? Always true on web.
 *   False on a desktop build that pinned no storage origin, whose main process
 *   refuses every download URL (fail-closed allow-list).
 * - `copySupported` — can this surface put an image on the system CLIPBOARD? The
 *   web adapter feature-detects `ClipboardItem` + `navigator.clipboard.write`,
 *   which older Safari/Firefox lack.
 */
export interface ImagesBridge {
  readonly saveSupported: boolean;
  readonly copySupported: boolean;
  save(request: ImageActionRequest): Promise<ImageSaveResult>;
  copy(request: ImageActionRequest): Promise<ImageCopyResult>;
}

/* ── 11. externalLinks (open an address in the OS browser) ──────────────── */

/**
 * Open ONE http(s) address outside the app.
 *
 * Desktop routes this through a validated IPC to `shell.openExternal`; web opens
 * a `noopener` tab. It exists as an explicit verb because the desktop window's
 * `setWindowOpenHandler` is an UNCONDITIONAL DENY: a `window.open` from anywhere
 * in the window — including the Watch Party embed's own links — creates nothing
 * and reaches nothing. Our ui therefore asks for a browser tab on purpose,
 * through a channel embedded third-party content cannot reach.
 *
 * Resolves `true` when the address was accepted, `false` when it was refused
 * (not http(s), unparseable, over budget) or the handoff failed. Never rejects.
 */
export interface ExternalLinksBridge {
  open(url: string): Promise<boolean>;
}

/* ── The aggregate bridge ───────────────────────────────────────────────── */

/**
 * The full platform surface the shared product UI depends on. Desktop provides
 * it from the Electron preload; web provides browser-native equivalents (see
 * desktop-bridge.ts / web-bridge.ts).
 */
export interface PlatformBridge {
  appInfo: AppInfo;
  capture: CaptureBridge;
  processAudio: ProcessAudioBridge;
  secureToken: SecureTokenBridge;
  secureVault: SecureVaultBridge;
  crash: CrashBridge;
  updates: UpdatesBridge;
  system: SystemBridge;
  notifications: NotificationsBridge;
  images: ImagesBridge;
  externalLinks: ExternalLinksBridge;
}
