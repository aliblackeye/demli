import React from "react";
import ReactDOM from "react-dom/client";
import { AppRoot } from "./AppRoot";
import { installGlobalErrorReporting } from "./components/ErrorBoundary";
import "./styles/globals.css";

// Catch uncaught errors / unhandled rejections and forward them to the local
// crash log (deduped, silent). Install before the first render.
installGlobalErrorReporting();

// Render IMMEDIATELY — AppRoot paints the splash on its first frame and mounts
// <App/> once i18n resolves. (It used to await createDesktopI18n() before
// creating the root, which left the window blank for that whole step; the splash
// now covers it and reports it as a real boot phase.)
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>,
);
