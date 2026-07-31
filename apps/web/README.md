# @demli/web — browser client

The **desktop renderer, mounted unchanged in a browser.** There is no separate
web application: no web `App`, no web shell, no web store/realtime/queries. The
web build exists so anyone can reach Demli without installing the Electron or
Android app.

## How it works

`src/main.tsx` does three things, in order:

1. installs the `window.demli` bridge (`src/shim/demli-bridge.ts`) — the
   browser stand-in for Electron's preload API, installed **before** the
   renderer is imported because renderer modules dereference `window.demli`
   at import time;
2. imports `src/styles/desktop-shell.css`, which `@import`s the desktop
   renderer's own `globals.css` (Tailwind v4 `@theme` + `@utility` layers) and
   adds an explicit `@source` scan of the renderer tree, since the Vite root is
   `apps/web` and Tailwind's automatic content detection would not reach it;
3. mounts the exact same `AppRoot` the Electron renderer mounts, which owns the
   boot sequence (font + i18n phases, splash, error boundary).

Importing rather than copying is the point: the two surfaces cannot drift.

`index.html` paints a static `#boot-skeleton` whose geometry mirrors
`BootSplash.tsx` exactly — `index.html` is served no-cache while the JS bundle
is not, so first paint can land well before the app does.

## Browser target

**Modern browsers only** (`build.target: "esnext"`). The earlier iOS 12 /
Safari 12 build path — Tailwind v3 + autoprefixer, `@vitejs/plugin-legacy`,
core-js polyfills, a nomodule/SystemJS chunk, a hand-written `src/polyfills/`
directory — was **removed** when the web client switched to sharing the desktop
renderer, which is Tailwind v4 and cannot run on Safari 12. Old browsers are
best-effort, not a supported target.

## Structure

```
src/
  main.tsx                boot: shim → stylesheet → mount desktop AppRoot
  shim/demli-bridge.ts browser implementation of the window.demli preload API
  styles/desktop-shell.css re-export of the renderer's globals.css + @source scan
  __tests__/              endpoint default guards
```

Business logic comes as-is from the platform-agnostic packages
(`@demli/client-core`, `protocol`, `types`, `config`, `i18n`, `media`,
`ui`, `app-ui`).

## Commands

```bash
pnpm --filter @demli/web dev         # dev server on :5175
pnpm --filter @demli/web build       # production build
pnpm --filter @demli/web typecheck
```

## Env

Copy `.env.example` → `.env`. **All endpoint defaults point at the production
hosts**, so an unconfigured build still reaches the live backend — override
`VITE_API_URL` / `VITE_REALTIME_URL` to develop against a local server.
`vite.config.ts` bakes the resolved values in with `define`, and reads the
desktop installer version from `apps/desktop/package.json` so the "download the
desktop app" button always names the current release.
