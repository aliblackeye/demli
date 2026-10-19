import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  CAPTURE_CHANNELS,
  type CaptureSelectionRequest,
  type CaptureSelectionResult,
  type CaptureSource,
  type DisplaySourceServedEvent,
  type ListSourcesOptions,
} from "../main/capture-types";
import {
  PROCESS_AUDIO_CHANNELS,
  type ProcessAudioBridge,
  type ProcessAudioChunk,
  type ProcessAudioEndedEvent,
  type ProcessAudioStartRequest,
  type ProcessAudioStartResult,
  type ProcessAudioSupport,
} from "../main/process-audio-types";
import {
  SECURE_TOKEN_CHANNELS,
  type SecureTokenBridge,
} from "../main/secure-token-types";
import {
  SECURE_VAULT_CHANNELS,
  type SecureVaultBridge,
} from "../main/secure-vault-types";
import {
  CRASH_CHANNELS,
  type CrashBridge,
  type RendererErrorReport,
} from "../main/crash-reporter-types";
import {
  UPDATE_CHANNELS,
  type UpdatesBridge,
  type UpdateStatus,
} from "../main/auto-update-types";
import {
  SYSTEM_CHANNELS,
  type DesktopSystemSettings,
  type SystemBridge,
  type TrayVoiceStatus,
} from "../main/system-types";
import {
  NOTIFICATION_CHANNELS,
  type NotificationNavigate,
  type NotificationRequest,
  type NotificationsBridge,
} from "../main/notifications-types";
import {
  SYSTEM_IDLE_CHANNELS,
  type SystemIdleBridge,
  type SystemIdleState,
  type SystemIdleWatchOptions,
} from "../main/system-idle-types";
import {
  IMAGE_ACTION_CHANNELS,
  type ImageActionRequest,
  type ImageCopyResult,
  type ImagesBridge,
  type ImageSaveResult,
} from "../main/image-actions-types";
import {
  hasImageActionOrigins,
  parseAllowedOrigins,
} from "../main/image-actions-policy";
import {
  EXTERNAL_LINK_CHANNELS,
  type ExternalLinksBridge,
} from "../main/external-link-types";

/**
 * Preload bridge — the ONLY surface the renderer gets.
 * Keep this minimal. Every exposed function must validate its inputs and
 * must never hand raw Node.js/Electron capabilities to the renderer.
 *
 * Note: no raw `ipcRenderer`, no generic `invoke(channel, ...)` passthrough,
 * and no Node modules are exposed. Each method targets a single fixed channel
 * whose payload is re-validated in the main process (see `main/capture.ts`).
 */

const capture = {
  /** Enumerate capturable screens/windows for our in-app picker. */
  listSources(options?: ListSourcesOptions): Promise<CaptureSource[]> {
    return ipcRenderer.invoke(CAPTURE_CHANNELS.listSources, options);
  },

  /**
   * Arm the source that the NEXT `getDisplayMedia()` call will receive. Single-
   * shot: must be called again before each new share. Always served as video
   * only — share sound comes from `processAudio`.
   */
  selectSource(
    request: CaptureSelectionRequest,
  ): Promise<CaptureSelectionResult> {
    return ipcRenderer.invoke(CAPTURE_CHANNELS.selectSource, request);
  },

  /** Discard any armed selection (cancel the picker, or clean up after a share). */
  clearSelection(): Promise<void> {
    return ipcRenderer.invoke(CAPTURE_CHANNELS.clearSelection);
  },

  /**
   * Subscribe to the "a source was served" notification. Fires when the main
   * process actually hands a source to Chromium, reporting the audio mode it
   * attempted ("loopback" | "none") so the renderer can reconcile it against
   * the real MediaStream tracks. Returns an unsubscribe function.
   *
   * The raw IPC event is intentionally NOT forwarded — only the sanitized
   * payload reaches the renderer callback.
   */
  onDisplaySourceServed(
    listener: (event: DisplaySourceServedEvent) => void,
  ): () => void {
    const channelListener = (
      _event: IpcRendererEvent,
      payload: DisplaySourceServedEvent,
    ): void => listener(payload);
    ipcRenderer.on(CAPTURE_CHANNELS.displaySourceServed, channelListener);
    return () => {
      ipcRenderer.removeListener(
        CAPTURE_CHANNELS.displaySourceServed,
        channelListener,
      );
    };
  },
} as const;

/**
 * Per-process audio bridge (Windows process loopback). Mirrors the capture
 * bridge shape: fixed channels, main-re-validated payloads, and subscribe
 * methods that forward ONLY the sanitized payload (never the raw IPC event) and
 * return an unsubscribe function. The renderer passes a mode plus, for "app",
 * a `sourceId` (never a PID); main resolves the PID and streams PCM back. See
 * `main/process-audio.ts` for the security posture.
 */
const processAudio: ProcessAudioBridge = {
  support(): Promise<ProcessAudioSupport> {
    return ipcRenderer.invoke(PROCESS_AUDIO_CHANNELS.support);
  },
  start(request: ProcessAudioStartRequest): Promise<ProcessAudioStartResult> {
    return ipcRenderer.invoke(PROCESS_AUDIO_CHANNELS.start, request);
  },
  stop(captureId: number): Promise<void> {
    return ipcRenderer.invoke(PROCESS_AUDIO_CHANNELS.stop, captureId);
  },
  onData(listener: (chunk: ProcessAudioChunk) => void): () => void {
    const channelListener = (
      _event: IpcRendererEvent,
      payload: ProcessAudioChunk,
    ): void => listener(payload);
    ipcRenderer.on(PROCESS_AUDIO_CHANNELS.data, channelListener);
    return () => {
      ipcRenderer.removeListener(PROCESS_AUDIO_CHANNELS.data, channelListener);
    };
  },
  onEnded(listener: (event: ProcessAudioEndedEvent) => void): () => void {
    const channelListener = (
      _event: IpcRendererEvent,
      payload: ProcessAudioEndedEvent,
    ): void => listener(payload);
    ipcRenderer.on(PROCESS_AUDIO_CHANNELS.ended, channelListener);
    return () => {
      ipcRenderer.removeListener(PROCESS_AUDIO_CHANNELS.ended, channelListener);
    };
  },
};

/**
 * Session-token bridge. Each method targets a single fixed channel whose
 * payload is re-validated in the main process (see `main/secure-token.ts`),
 * where the token is stored OS-encrypted via `safeStorage`. No raw token ever
 * touches renderer-accessible storage (security-review M1). This is the desktop
 * implementation of the shared `TokenStorage` seam (ADR 0002).
 */
const secureToken: SecureTokenBridge = {
  get(): Promise<string | null> {
    return ipcRenderer.invoke(SECURE_TOKEN_CHANNELS.get);
  },
  set(token: string): Promise<void> {
    return ipcRenderer.invoke(SECURE_TOKEN_CHANNELS.set, token);
  },
  clear(): Promise<void> {
    return ipcRenderer.invoke(SECURE_TOKEN_CHANNELS.clear);
  },
};

/**
 * Account-vault bridge (M15 / ADR 0013). A second OS-encrypted single-value slot
 * beside {@link secureToken}, holding the multi-account registry JSON blob. Same
 * fixed-channel, main-re-validated, safeStorage-backed shape — the renderer's
 * desktop implementation of the shared `VaultStorage` seam. Multiple tokens live
 * here, so it never touches renderer-accessible storage either.
 */
const secureVault: SecureVaultBridge = {
  get(): Promise<string | null> {
    return ipcRenderer.invoke(SECURE_VAULT_CHANNELS.get);
  },
  set(value: string): Promise<void> {
    return ipcRenderer.invoke(SECURE_VAULT_CHANNELS.set, value);
  },
  clear(): Promise<void> {
    return ipcRenderer.invoke(SECURE_VAULT_CHANNELS.clear);
  },
};

/**
 * Crash-reporting bridge. Report-only: the renderer can push a structured error
 * report (React error boundary + global window handlers) which the main process
 * re-validates and appends to the local crash log (see `main/crash-reporter.ts`).
 * The renderer can never read the crash log or minidump directory back out.
 */
const crash: CrashBridge = {
  reportRendererError(report: RendererErrorReport): Promise<void> {
    return ipcRenderer.invoke(CRASH_CHANNELS.reportRenderer, report);
  },
};

/**
 * Auto-update bridge. All renderer -> main calls are argument-free (no untrusted
 * payload crosses); the main process authors every status. `onStatus` forwards
 * only the sanitized {@link UpdateStatus} payload — never the raw IPC event — and
 * returns an unsubscribe function (mirroring capture's `onDisplaySourceServed`).
 * See `main/auto-update.ts`.
 */
const updates: UpdatesBridge = {
  check(): Promise<UpdateStatus> {
    return ipcRenderer.invoke(UPDATE_CHANNELS.check);
  },
  getStatus(): Promise<UpdateStatus> {
    return ipcRenderer.invoke(UPDATE_CHANNELS.getStatus);
  },
  onStatus(listener: (status: UpdateStatus) => void): () => void {
    const channelListener = (
      _event: IpcRendererEvent,
      status: UpdateStatus,
    ): void => listener(status);
    ipcRenderer.on(UPDATE_CHANNELS.status, channelListener);
    return () => {
      ipcRenderer.removeListener(UPDATE_CHANNELS.status, channelListener);
    };
  },
  downloadAndInstall(): Promise<void> {
    return ipcRenderer.invoke(UPDATE_CHANNELS.downloadAndInstall);
  },
};

/**
 * Desktop-system bridge (tray + launch-at-startup). The renderer can only read
 * the settings, flip the two named booleans, and push the two transient tray
 * signals (unread + own voice state); every payload is re-validated in main (see
 * `main/system.ts`). No filesystem/shell/login-item internals are exposed, and
 * the renderer never picks the tray IMAGE — it reports state, main decides.
 */
const system: SystemBridge = {
  getSettings(): Promise<DesktopSystemSettings> {
    return ipcRenderer.invoke(SYSTEM_CHANNELS.getSettings);
  },
  setCloseToTray(enabled: boolean): Promise<DesktopSystemSettings> {
    return ipcRenderer.invoke(SYSTEM_CHANNELS.setCloseToTray, enabled);
  },
  setAutoLaunch(enabled: boolean): Promise<DesktopSystemSettings> {
    return ipcRenderer.invoke(SYSTEM_CHANNELS.setAutoLaunch, enabled);
  },
  setUnreadBadge(hasUnread: boolean): Promise<void> {
    return ipcRenderer.invoke(SYSTEM_CHANNELS.setUnreadBadge, hasUnread);
  },
  setVoiceStatus(status: TrayVoiceStatus): Promise<void> {
    // Rebuilt field by field rather than forwarded: the renderer's object may
    // carry extra keys, and main's schema is strict — normalising here keeps a
    // harmless caller from getting a rejection it cannot diagnose.
    return ipcRenderer.invoke(SYSTEM_CHANNELS.setVoiceStatus, {
      inVoiceSession: status.inVoiceSession,
      micEnabled: status.micEnabled,
      deafened: status.deafened,
    });
  },
};

/**
 * System-idle bridge — OS-WIDE inactivity, for automatic "boşta" presence. The
 * renderer arms the watcher with its own threshold (re-validated AND bounded in
 * main, see `main/system-idle.ts`) and listens; it gets no `powerMonitor` access
 * and never sees the raw idle duration — only `{ idle, reason }`. `onChanged`
 * forwards only the sanitized payload, never the raw IPC event, and returns an
 * unsubscribe function (mirrors capture's `onDisplaySourceServed`).
 */
const systemIdle: SystemIdleBridge = {
  start(options: SystemIdleWatchOptions): Promise<SystemIdleState> {
    return ipcRenderer.invoke(SYSTEM_IDLE_CHANNELS.start, options);
  },
  stop(): Promise<void> {
    return ipcRenderer.invoke(SYSTEM_IDLE_CHANNELS.stop);
  },
  onChanged(listener: (state: SystemIdleState) => void): () => void {
    const channelListener = (
      _event: IpcRendererEvent,
      state: SystemIdleState,
    ): void => listener(state);
    ipcRenderer.on(SYSTEM_IDLE_CHANNELS.changed, channelListener);
    return () => {
      ipcRenderer.removeListener(SYSTEM_IDLE_CHANNELS.changed, channelListener);
    };
  },
};

/**
 * Notifications bridge. `notify` hands a validated request to main (re-validated
 * there before a native toast is shown — see `main/notifications.ts`); `onActivated`
 * forwards only the sanitized navigate target on click, never the raw IPC event,
 * and returns an unsubscribe function (mirrors capture's `onDisplaySourceServed`).
 */
const notifications: NotificationsBridge = {
  notify(request: NotificationRequest): Promise<void> {
    return ipcRenderer.invoke(NOTIFICATION_CHANNELS.notify, request);
  },
  onActivated(
    listener: (navigate: NotificationNavigate) => void,
  ): () => void {
    const channelListener = (
      _event: IpcRendererEvent,
      navigate: NotificationNavigate,
    ): void => listener(navigate);
    ipcRenderer.on(NOTIFICATION_CHANNELS.activated, channelListener);
    return () => {
      ipcRenderer.removeListener(NOTIFICATION_CHANNELS.activated, channelListener);
    };
  },
  requestFocus(): Promise<void> {
    return ipcRenderer.invoke(NOTIFICATION_CHANNELS.requestFocus);
  },
};

/**
 * The storage origins this build pinned, injected by electron-vite `define`
 * (electron.vite.config.ts) — the SAME string the main bundle gets. The preload
 * needs it only to answer "can this build do image actions at all", which the UI
 * asks synchronously during render.
 */
declare const __DEMLI_IMAGE_ORIGINS__: string;

/**
 * Whether this build pinned any storage origin. When it did not, main's
 * allow-list is empty and refuses EVERY url (fail-closed — see
 * main/image-actions-policy.ts), so the feature is off and the UI must not
 * render entries for it (CLAUDE.md §35 — no dead buttons).
 */
const imageActionsEnabled: boolean = hasImageActionOrigins(
  parseAllowedOrigins(typeof __DEMLI_IMAGE_ORIGINS__ === "string" ? __DEMLI_IMAGE_ORIGINS__ : ""),
);

/**
 * Image actions for a picture shared in chat. The renderer gets NO filesystem
 * and NO clipboard-image access: it only names the image it is already showing
 * (signed URL + MIME + a suggested file name) and main does the privileged
 * work — native save dialog + write, or `clipboard.writeImage`. Every payload is
 * re-validated in main, the URL must be on the build-pinned storage allow-list,
 * and the downloaded bytes are never handed back here (see `main/image-actions.ts`).
 *
 * The two flags are plain booleans, not calls: the UI reads them during render
 * to decide whether each entry exists at all. On desktop both track the same
 * thing — whether the build pinned a storage origin — because a clipboard we
 * cannot fetch bytes for is as dead as a save we cannot fetch bytes for.
 */
const images: ImagesBridge = {
  saveSupported: imageActionsEnabled,
  copySupported: imageActionsEnabled,
  save(request: ImageActionRequest): Promise<ImageSaveResult> {
    return ipcRenderer.invoke(IMAGE_ACTION_CHANNELS.save, request);
  },
  copy(request: ImageActionRequest): Promise<ImageCopyResult> {
    return ipcRenderer.invoke(IMAGE_ACTION_CHANNELS.copy, request);
  },
};

/**
 * External links. ONE verb — open an http(s) address in the OS browser — and no
 * `shell` object behind it, so `openPath` / `showItemInFolder` / `trashItem`
 * remain unreachable from the renderer.
 *
 * This namespace is what makes the window-open handler an unconditional deny
 * possible: our own ui asks for a browser tab explicitly here, while embedded
 * third-party content (the Watch Party player) has no path to the OS at all. The
 * url is re-validated in main (bounded, parsed, http(s) only, no embedded
 * credentials) and the sender must be the top frame of one of our own windows —
 * see `main/external-link.ts`.
 */
const externalLinks: ExternalLinksBridge = {
  open(url: string): Promise<boolean> {
    return ipcRenderer.invoke(EXTERNAL_LINK_CHANNELS.open, url);
  },
};

/** Injected by electron-vite `define` (electron.vite.config.ts) — the real
 * package.json version. `npm_package_version` only exists under pnpm, so the
 * old fallback showed "0.0.1" forever in packaged builds. */
declare const __APP_VERSION__: string;

const api = {
  appInfo: {
    version: __APP_VERSION__,
    platform: process.platform,
  },
  capture,
  processAudio,
  secureToken,
  secureVault,
  crash,
  updates,
  system,
  systemIdle,
  notifications,
  images,
  externalLinks,
} as const;

contextBridge.exposeInMainWorld("demli", api);

export type DemliBridge = typeof api;

// Re-export the capture contract types so the renderer can import named types
// from the preload entry without reaching into `main/`. `export type` is fully
// erased at build time — no runtime effect on the preload bundle.
export type {
  CaptureSelectionRequest,
  CaptureSelectionResult,
  CaptureSource,
  CaptureSourceKind,
  DisplaySourceServedEvent,
  ListSourcesOptions,
} from "../main/capture-types";

export type {
  ProcessAudioBridge,
  ProcessAudioChunk,
  ProcessAudioEndedEvent,
  ProcessAudioFormat,
  ProcessAudioMode,
  ProcessAudioStartRequest,
  ProcessAudioStartResult,
  ProcessAudioSupport,
  ProcessAudioUnavailableReason,
} from "../main/process-audio-types";

export type { SecureTokenBridge } from "../main/secure-token-types";

export type { SecureVaultBridge } from "../main/secure-vault-types";

export type {
  CrashBridge,
  RendererErrorReport,
} from "../main/crash-reporter-types";

export type {
  UpdatesBridge,
  UpdateStatus,
  UpdateStatusKind,
} from "../main/auto-update-types";

export type {
  DesktopSystemSettings,
  SystemBridge,
  TrayVoiceStatus,
} from "../main/system-types";

export type {
  NotificationNavigate,
  NotificationRequest,
  NotificationsBridge,
} from "../main/notifications-types";

export type {
  SystemIdleBridge,
  SystemIdleReason,
  SystemIdleState,
  SystemIdleWatchOptions,
} from "../main/system-idle-types";

export type {
  ImageActionFailure,
  ImageActionRequest,
  ImageCopyResult,
  ImageSaveResult,
  ImagesBridge,
} from "../main/image-actions-types";

export type { ExternalLinksBridge } from "../main/external-link-types";
