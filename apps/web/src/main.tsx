/*
 * Web entry — the app is the DESKTOP renderer, mounted unchanged in a browser.
 *
 * There is NO separate web application any more: no web App/WideShell/MobileShell,
 * no web store/realtime/queries. This file only (1) installs the window.demli
 * shim, (2) loads the desktop renderer's own stylesheet, then (3) mounts the exact
 * same AppRoot the Electron renderer mounts — which owns the boot sequence (font +
 * i18n phases, startup splash, error boundary), so the two surfaces cannot drift.
 */

// 1. Install the browser window.demli bridge FIRST — before the desktop
//    renderer is imported, because renderer modules dereference window.demli
//    at import / first-render time. (Side-effect import; installs on load.)
import "./shim/demli-bridge";

// 2. Tailwind v4 stylesheet = the desktop renderer's globals.css (single source),
//    plus an explicit @source for the renderer tree (see desktop-shell.css).
import "./styles/desktop-shell.css";

import React from "react";
import ReactDOM from "react-dom/client";
// 3. The desktop renderer's root, imported directly across the app boundary
//    (relative path; the hoisted node_modules layout resolves every third-party dep).
import { AppRoot } from "../../desktop/src/renderer/src/AppRoot";
import { installGlobalErrorReporting } from "../../desktop/src/renderer/src/components/ErrorBoundary";

// Catch uncaught errors / unhandled rejections and forward them to the bridge's
// crash sink (console on web). Install before the first render — mirrors desktop.
installGlobalErrorReporting();

// Render immediately: AppRoot's splash takes over from the static #boot-skeleton
// painted by index.html, so there is no blank frame between the two.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>,
);
