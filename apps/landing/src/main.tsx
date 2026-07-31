/**
 * Landing-page entry. i18n is resolved BEFORE the first render so the page never
 * paints English copy and then swaps it to Turkish a frame later — the catalogs
 * are bundled and synchronous, so the await costs nothing measurable.
 *
 * The motion flag is set BEFORE the render for the same reason: the scroll
 * reveals must already be hidden on their first paint, or the page would flash
 * every block at full opacity and then animate it in from nothing.
 */

import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { I18nextProvider } from "@demli/i18n";
import { App } from "./App";
import { createLandingI18n } from "./i18n";
import { enableMotionEnhancements } from "./lib/motion";
import "./styles/globals.css";

async function boot(): Promise<void> {
  const container = document.getElementById("root");
  if (!container) throw new Error("#root is missing from index.html");

  enableMotionEnhancements();

  const i18n = await createLandingI18n();

  createRoot(container).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>
    </StrictMode>,
  );
}

void boot();
