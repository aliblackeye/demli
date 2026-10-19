/**
 * Web PlatformBridge adapter — browser-native equivalents of the Electron
 * preload namespaces, so the shared product UI runs unchanged in a browser.
 *
 * The behaviours mirror the ones already shipping in apps/web (its
 * src/platform/* adapters and src/notifications/web-notifications.ts). They are
 * re-implemented here rather than imported, because a shared package must not
 * depend on an app — but the semantics are intentionally identical:
 *
 *   - secureToken / secureVault → localStorage, wrapped so iOS 12 Safari Private
 *     Mode (which throws on setItem) degrades to "not persisted", never crashes.
 *   - notifications             → the Web Notifications API, feature-detected
 *     (absent on iOS 12 Safari) and shown when permission is granted. It is a
 *     SINK only: whether an alert is worth showing is decided once, for both
 *     surfaces, by the renderer's notify policy — this adapter must not add a
 *     second gate (it used to also require a backgrounded tab, which silently
 *     ate every alert the policy allowed while the tab was focused).
 *   - capture                   → gated on getDisplayMedia (the browser owns the
 *     source picker; there is nothing to pre-enumerate/arm).
 *   - appInfo                   → { platform: "web", version }.
 *   - updates / system / crash / processAudio → honest web no-ops (no
 *     auto-updater, no tray/login-item, no Windows process loopback).
 *   - externalLinks             → a `noopener` tab. On desktop this namespace
 *     exists because `setWindowOpenHandler` is an unconditional deny; on web the
 *     tab IS the mechanism, so it wraps `window.open` directly.
 *
 * Every method is total and non-throwing (CLAUDE.md §26): a browser that lacks a
 * capability degrades quietly instead of surfacing a raw error.
 */
import type {
  CaptureSelectionRequest,
  CaptureSelectionResult,
  CaptureSource,
  DisplaySourceServedEvent,
  DesktopSystemSettings,
  ListSourcesOptions,
  NotificationNavigate,
  NotificationRequest,
  PlatformBridge,
  ProcessAudioChunk,
  ProcessAudioEndedEvent,
  ProcessAudioStartRequest,
  ProcessAudioStartResult,
  ProcessAudioSupport,
  RendererErrorReport,
  TrayVoiceStatus,
  UpdateStatus,
} from "./bridge-types";
import { createWebImagesBridge } from "./web-image-actions";
import { isExternalHttpUrl } from "./external-link";

/** localStorage key for the single session token. Matches apps/web storage.ts. */
const WEB_TOKEN_KEY = "demli.token";

/**
 * localStorage key for the multi-account vault blob. MUST stay equal to
 * `ACCOUNT_VAULT_STORAGE_KEY` in @demli/client-core (account-vault/vault-model.ts)
 * so this bridge and apps/web read/write the SAME slot. Inlined (not imported) to
 * keep app-ui free of a client-core dependency; the value is a stable contract.
 */
const WEB_VAULT_KEY = "demli.account-vault";

/**
 * Synthetic sources for the browser's own getDisplayMedia picker, one per
 * display surface. The id carries the surface the picker should OPEN on
 * (`video.displaySurface`); the browser still lets the user switch panes.
 * The in-app picker renders its own localized labels for these — `name` is a
 * plain fallback only.
 */
const WEB_DISPLAY_SOURCES: readonly CaptureSource[] = [
  { id: "web:display:browser", name: "Browser tab", kind: "window", thumbnailDataUrl: "" },
  { id: "web:display:monitor", name: "Entire screen", kind: "screen", thumbnailDataUrl: "" },
  { id: "web:display:window", name: "Window", kind: "window", thumbnailDataUrl: "" },
];

/** Never-fires unsubscribe for the web no-op event subscriptions. */
const noop = (): void => {};

interface AsyncStringStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}

/** localStorage-backed async string store, safe under Private Mode / disabled storage. */
function createWebStringStore(key: string): AsyncStringStore {
  return {
    async get() {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    async set(value: string) {
      try {
        localStorage.setItem(key, value);
      } catch {
        // Private Mode / quota — the value simply won't survive a reload.
      }
    },
    async clear() {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
    },
  };
}

function canGetDisplayMedia(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === "function"
  );
}

function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/**
 * A per-conversation tag, so two different conversations produce two toasts.
 *
 * A single fixed tag makes every notification REPLACE the previous one: three
 * people writing in three places collapsed into one card and the user learned
 * about exactly one of them. Keying by destination keeps one card per
 * conversation (a burst in the same channel still coalesces, which is what the
 * per-channel throttle wants anyway).
 */
function notificationTag(navigate: NotificationNavigate): string {
  switch (navigate.target) {
    case "channel":
      return `demli:channel:${navigate.channelId}`;
    case "groupChat":
      return `demli:groupChat:${navigate.groupChatId}`;
    case "dm":
      return `demli:dm:${navigate.dmId}`;
    default:
      return `demli:${navigate.target}`;
  }
}

/** Options for the web bridge. `version` is injected by the host app's build. */
export interface WebBridgeOptions {
  /** App/build version string (e.g. Vite's VITE_APP_VERSION). Default "0.0.0". */
  version?: string;
}

/**
 * Build a web {@link PlatformBridge}. Call once near the app root and hand the
 * result to `<PlatformProvider bridge={…}>`.
 */
export function createWebBridge(options: WebBridgeOptions = {}): PlatformBridge {
  const version = options.version ?? "0.0.0";
  const tokenStore = createWebStringStore(WEB_TOKEN_KEY);
  const vaultStore = createWebStringStore(WEB_VAULT_KEY);

  // Instance-scoped registry: a clicked notification fans its navigate target
  // out to everyone subscribed via notifications.onActivated.
  const activatedListeners = new Set<(navigate: NotificationNavigate) => void>();

  return {
    appInfo: { platform: "web", version },

    capture: {
      // The browser owns the real source picker (shown by getDisplayMedia
      // itself). Expose one intent per display surface, only when the browser
      // can actually capture; otherwise none.
      async listSources(_options?: ListSourcesOptions): Promise<CaptureSource[]> {
        if (!canGetDisplayMedia()) return [];
        return WEB_DISPLAY_SOURCES.map((source) => ({ ...source }));
      },
      // Web cannot arm a specific source ahead of time; the actual capture flows
      // through navigator.mediaDevices.getDisplayMedia in the media layer.
      async selectSource(request: CaptureSelectionRequest): Promise<CaptureSelectionResult> {
        return { ok: true, sourceId: request.sourceId };
      },
      async clearSelection(): Promise<void> {},
      onDisplaySourceServed(_listener: (event: DisplaySourceServedEvent) => void): () => void {
        // No web analogue — the browser serves the stream directly to the caller.
        return noop;
      },
    },

    processAudio: {
      // Windows per-process WASAPI loopback has no browser equivalent.
      async support(): Promise<ProcessAudioSupport> {
        return { supported: false, reason: "unsupported_platform" };
      },
      async start(_request: ProcessAudioStartRequest): Promise<ProcessAudioStartResult> {
        return { ok: false, reason: "unsupported_platform" };
      },
      async stop(_captureId: number): Promise<void> {},
      onData(_listener: (chunk: ProcessAudioChunk) => void): () => void {
        return noop;
      },
      onEnded(_listener: (event: ProcessAudioEndedEvent) => void): () => void {
        return noop;
      },
    },

    secureToken: {
      get: () => tokenStore.get(),
      set: (token: string) => tokenStore.set(token),
      clear: () => tokenStore.clear(),
    },

    secureVault: {
      get: () => vaultStore.get(),
      set: (value: string) => vaultStore.set(value),
      clear: () => vaultStore.clear(),
    },

    crash: {
      // No local crash log on web; surface the report to the console for dev
      // diagnostics (a real sink like Sentry is wired at the app level, M19).
      async reportRendererError(report: RendererErrorReport): Promise<void> {
        try {
          console.error("[demli] renderer error", report);
        } catch {
          // ignore
        }
      },
    },

    updates: {
      // The browser updates itself; there is no in-app updater.
      async check(): Promise<UpdateStatus> {
        return { kind: "disabled" };
      },
      async getStatus(): Promise<UpdateStatus> {
        return { kind: "disabled" };
      },
      onStatus(_listener: (status: UpdateStatus) => void): () => void {
        return noop;
      },
      async downloadAndInstall(): Promise<void> {},
    },

    system: {
      // No tray, no OS login item on web — the flags are always off and setters
      // are no-ops that echo the fixed state (so callers don't special-case web).
      async getSettings(): Promise<DesktopSystemSettings> {
        return { closeToTray: false, autoLaunch: false };
      },
      async setCloseToTray(_enabled: boolean): Promise<DesktopSystemSettings> {
        return { closeToTray: false, autoLaunch: false };
      },
      async setAutoLaunch(_enabled: boolean): Promise<DesktopSystemSettings> {
        return { closeToTray: false, autoLaunch: false };
      },
      // A browser tab has no notification-area icon to badge and no tray icon to
      // swap, so both tray signals are accepted and dropped. The unread/voice
      // state the caller is reporting is already on screen in the rail badges and
      // the voice panel; nothing is lost by ignoring it here.
      async setUnreadBadge(_hasUnread: boolean): Promise<void> {
        return undefined;
      },
      async setVoiceStatus(_status: TrayVoiceStatus): Promise<void> {
        return undefined;
      },
    },

    notifications: {
      // Show a browser notification when supported and permission is granted.
      //
      // This is a SINK, not a policy: WHETHER an alert deserves a notification is
      // decided once, for both surfaces, in the renderer's notify policy
      // (apps/desktop/src/renderer/src/notifications/notify-policy.ts). This used
      // to additionally require the tab to be backgrounded, which silently
      // re-suppressed everything the policy had just allowed — a message in
      // another conversation while the tab is focused is exactly the case the
      // founder reported as missing, and this gate would have eaten it a second
      // time. The permission check stays: it is a browser fact, not a policy.
      //
      // Clicking focuses the window and replays the navigate target to
      // onActivated subscribers.
      async notify(request: NotificationRequest): Promise<void> {
        if (!notificationsSupported()) return;
        try {
          if (Notification.permission !== "granted") return;
          const toast = new Notification(request.title, {
            body: request.body,
            tag: notificationTag(request.navigate),
          });
          toast.onclick = () => {
            try {
              window.focus();
            } catch {
              // ignore
            }
            toast.close();
            for (const listener of activatedListeners) {
              try {
                listener(request.navigate);
              } catch {
                // one bad listener must not stop the others
              }
            }
          };
        } catch {
          // Some engines throw when constructing off a user gesture — ignore.
        }
      },
      onActivated(listener: (navigate: NotificationNavigate) => void): () => void {
        activatedListeners.add(listener);
        return () => {
          activatedListeners.delete(listener);
        };
      },
      async requestFocus(): Promise<void> {
        try {
          window.focus();
        } catch {
          // ignore
        }
      },
    },

    // Save / copy a chat image with browser APIs: the File System Access save
    // picker when available (a real directory choice), an `<a download>` blob
    // otherwise, and a feature-detected async-clipboard copy. See
    // ./web-image-actions.ts for why the two surfaces differ.
    images: createWebImagesBridge(),

    externalLinks: {
      // On web a new tab IS the mechanism, so this namespace is a thin wrapper
      // rather than an escape from a denied window-open (which is what it is on
      // desktop — see ./external-link.ts). `noopener,noreferrer` keeps the
      // opened page from reaching back through `window.opener`.
      //
      // Called synchronously from the click handler (the body runs before the
      // first await), so the browser still counts it as user-initiated and does
      // not treat it as a blocked popup.
      async open(url: string): Promise<boolean> {
        if (!isExternalHttpUrl(url)) return false;
        try {
          window.open(url, "_blank", "noopener,noreferrer");
          return true;
        } catch {
          return false;
        }
      },
    },
  };
}
