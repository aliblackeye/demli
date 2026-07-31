---
name: electron-security-review
description: Audit Electron security — contextIsolation, sandbox, preload bridge surface, IPC validation, navigation restrictions. Use before merging any change to apps/desktop/src/main or src/preload, and before any release.
---

# Electron Security Review

## When to use
Any diff touching `apps/desktop/src/main/`, `apps/desktop/src/preload/`, BrowserWindow creation, IPC channels, or `electron.vite.config.*`. Mandatory before `/ship`.

## Inputs
- The diff, plus current `apps/desktop/src/main/` and `src/preload/` in full (security holes hide in unchanged context).

## Procedure
1. BrowserWindow webPreferences: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` (and no `nodeIntegrationInWorker`), `webSecurity` not disabled. Grep the desktop app for each.
2. Preload surface: everything exposed via `contextBridge.exposeInMainWorld` is minimal and typed. No raw `fs`, `child_process`, `shell`, or generic `invoke(channel, ...)` passthrough exposed to the renderer.
3. IPC validation: every `ipcMain.handle`/`ipcMain.on` validates its payload (zod or equivalent) before acting. Sender checks where it matters. Privileged operations stay in main (CLAUDE.md §9).
4. Navigation: `will-navigate` blocked/allowlisted, `setWindowOpenHandler` denies or allowlists, `shell.openExternal` only on validated http(s) URLs.
5. Content: no remote URLs loaded into privileged windows; no `eval`/`new Function`; user content sanitized before render (no unsafe HTML/markdown — CLAUDE.md §28).
6. Grep sweep over the diff: `nodeIntegration`, `webSecurity`, `allowRunningInsecureContent`, `enableRemoteModule`, `shell.`, `openExternal`, `eval(`, `dangerouslySetInnerHTML`.
7. Desktop capture: `desktopCapturer` results flow only through the vetted IPC path; no arbitrary source id from the renderer trusted blindly.

## Checklist
- [ ] `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` on every window
- [ ] Preload exposes a minimal, typed API — no raw Node/fs/shell passthrough
- [ ] Every IPC handler validates its payload before use
- [ ] `will-navigate` + `setWindowOpenHandler` restrict navigation
- [ ] `shell.openExternal` gated to validated http(s) URLs
- [ ] No remote content in privileged windows, no eval patterns
- [ ] User message content sanitized before rendering
- [ ] Grep sweep clean

## Output format
Terse, in chat (CLAUDE.md §0.1): verdict (PASS/FAIL) first, then only the findings — BLOCKER / SHOULD-FIX / NOTE, each one line with file:line + the exact fix. Clean checks collapse to one line. A `.claude/reports/` file only on request (or when a ship gate needs the evidence retained).

## Failure conditions
Any BLOCKER = FAIL = merge and ship are blocked (CLAUDE.md §35: do not let Electron security rot). A missing check that cannot be verified (e.g. window created dynamically with unknown prefs) counts as a BLOCKER until proven safe.
