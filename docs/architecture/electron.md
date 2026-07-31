# Electron Architecture

Three-process split, enforced in `apps/desktop/src/{main,preload,renderer}`.

## Main process (`src/main`)

Privileged. Owns:

- App lifecycle, window creation/management
- Tray, native menus, global shortcuts (later)
- Desktop capture permissions and source picking (Milestone 4)
- Auto-updater (Milestone 5)
- Crash reporting (Milestone 5) — native minidumps + process-gone + renderer
  errors, logged locally. See [crash-reporting.md](./crash-reporting.md).
- OS-wide idle detection (`powerMonitor` inactivity clock + lock/sleep) behind
  automatic "boşta" presence — the renderer cannot see input that lands in other
  apps, so main measures and pushes `{ idle, reason }`. See `src/main/system-idle.ts`.
- Image actions for chat attachments — the native "save as" dialog + file write,
  and `clipboard.writeImage` for "copy image". The renderer names the picture it
  is already showing; main enforces an https storage-origin allow-list (pinned at
  build time from `DEMLI_STORAGE_ORIGIN` / `DEMLI_DOMAIN`), a 10 MB cap, a
  magic-byte check, and per-hop redirect validation. The bytes never return to
  the renderer. See `src/main/image-actions.ts` + `image-actions-policy.ts`.
- IPC handlers — every handler validates its payload before acting

Privileged logic lives here, never in React components.

## Preload (`src/preload`)

The ONLY bridge between renderer and main. Exposes a minimal, typed API via
`contextBridge.exposeInMainWorld("demli", api)`. Rules:

- Expose specific functions, never raw modules (`ipcRenderer`, `fs`, `shell`, …).
- Every exposed function validates inputs and wraps a narrow capability.
- Keep the surface small — if the renderer doesn't need it, don't expose it.

## Renderer (`src/renderer`)

Unprivileged web content: React app, UI, Zustand/TanStack Query state, HTTP/WebSocket clients,
LiveKit client, media controls. It has no Node.js access and reaches native capabilities only
through `window.demli`.

## Security posture (non-negotiable)

Set on every `BrowserWindow` (see `src/main/index.ts`):

- `contextIsolation: true`
- `sandbox: true`
- `nodeIntegration: false`
- Preload bridge only — no other renderer→native path
- IPC validation: main process treats every IPC payload as untrusted input
- Navigation restrictions:
  - `setWindowOpenHandler` denies **unconditionally** — no window, and no handoff to the
    OS either. Our own external links go through the validated `external-link:open` IPC
    (`main/external-link.ts`), which embedded third-party content cannot reach.
  - `will-navigate` blocks navigation away from our own UI (dev server URL or local file)
  - `will-frame-navigate` blocks subframe navigation off the embed origin

Do not weaken these for convenience. If a feature seems to need Node in the renderer, the
answer is a new validated IPC handler in main plus a narrow preload function — not a flag flip.
See security.md for the full security rules.
