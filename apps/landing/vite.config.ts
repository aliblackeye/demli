import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Demli landing page (getdemli.com) — a small static site, not a product surface.
 *
 * Deliberate choices:
 *
 *  - NO external requests at runtime. Fonts are the repo's own self-hosted woff2
 *    files (see src/styles/globals.css), images are same-origin assets, and there
 *    is no analytics/CDN/font-provider call. index.html ships a matching strict
 *    CSP, so a stray `fonts.googleapis.com` import would fail loudly instead of
 *    silently leaking visitors to a third party.
 *
 *  - `assetsInlineLimit: 0` — nothing is turned into a `data:` URI, so the CSP can
 *    stay at `img-src 'self'` / `font-src 'self'` with no `data:` escape hatch.
 *    There are no tiny assets here, so this costs no extra requests worth caring
 *    about and buys a provably external-request-free build.
 *
 *  - Every deployment-specific URL is a build-time `VITE_*` var with a sane
 *    default (see src/env.ts + .env.example) so moving the app or the download
 *    endpoints is a one-line change, not a code edit.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    target: "esnext",
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: { port: 5176, host: true },
  preview: { port: 5176, host: true },
});
