# @demli/landing — getdemli.com

The public landing page. A **temporary but real** site: one screen that says what
Demli is, sends visitors to the web client, and hands out the builds that
actually exist. Not a product surface — no auth, no API calls, no realtime.

## Build output

```bash
pnpm --filter @demli/landing dev        # local dev server (port 5176)
pnpm --filter @demli/landing build      # → apps/landing/dist   ← Caddy serves this
pnpm --filter @demli/landing preview    # serve the built dist (port 5176)
pnpm --filter @demli/landing typecheck
```

`dist/` is a plain static directory: `index.html` + hashed `assets/` + the
favicons from `public/`. Serve it with a SPA-less config — there is exactly one
route.

## Configuration

Every deployment URL is a build-time `VITE_*` var with a production default (see
`.env.example` and `src/env.ts`), so relocating the app or the download endpoints
never needs a code change:

| Var                         | Default                              | Used for                    |
| --------------------------- | ------------------------------------ | --------------------------- |
| `VITE_APP_URL`              | `https://app.getdemli.com`           | every "Open Demli" button   |
| `VITE_DOWNLOAD_WINDOWS_URL` | `https://getdemli.com/download/windows` | Windows installer        |
| `VITE_DOWNLOAD_ANDROID_URL` | `https://getdemli.com/download/android` | Android APK              |
| `VITE_GITHUB_URL`           | _(empty)_                            | open-source row — **hidden while empty** |

**Devops owns the two `/download/*` endpoints.** They must redirect to the real
artifacts: the current file in the desktop feed at
`https://api.getdemli.com/dl/desktop/` (exact filename lives in `latest.yml`),
and the fixed EAS APK link. Keeping the indirection there means a new release
never requires rebuilding this page.

## Honest platform matrix (CLAUDE.md §35 — no dead buttons)

| Platform      | Shown as       | Why                                                     |
| ------------- | -------------- | ------------------------------------------------------- |
| Windows       | Available + download | Ships today (electron-updater feed).              |
| Android       | Available + download | Ships today (APK + in-app self-updater).          |
| macOS         | Coming soon, **no link** | Build pipeline exists but has never been run. |
| Linux / iOS   | Not listed     | No plan. The browser-client note covers those visitors.  |

If a macOS build is ever cut, turn the disabled tile in `components/Downloads.tsx`
into a real link and add `VITE_DOWNLOAD_MACOS_URL` — do not link it before then.

## i18n

TR + EN through the shared `@demli/i18n` engine, in its own `landing`
namespace (`packages/i18n/src/locales/{en,tr}/landing.json`). The namespace is
covered by the package's TR⇄EN key-parity test and the compile-time key typing
like any product catalog.

`src/i18n.ts` initialises with `createI18nFor` + `landingResources` rather than
`createI18n`: the full tree also carries the desktop and mobile catalogs
(~170 KB of product copy) that a marketing page would ship as dead bytes. Locale
resolution is the standard chain — persisted choice → browser language → `en` —
and the TR/EN picker writes to `localStorage["demli.locale"]`.

## No external requests

The page ships a strict CSP (`default-src 'self'`, no `data:`) and makes **zero**
third-party requests:

- Fonts are the product's own Onest + Inter variable woff2 subsets (SIL OFL
  1.1), referenced from `apps/desktop/src/renderer/src/assets/fonts/` by
  `src/app/fonts.css` — not copied; Next emits them into `_next/static/media`.
  The OFL texts ship at `/fonts/OFL-*.txt`. Google Fonts is not used, at
  runtime or at build time (no `next/font/google`).
- Design tokens are imported from `packages/app-ui/src/tokens.css`; this page
  defines no colours of its own.
- `assetsInlineLimit: 0` keeps every asset a real file, so the CSP needs no
  `data:` escape hatch and "no external request" is verifiable by grepping
  `dist/` for `http`.

Caddy should still send `frame-ancestors`, `X-Content-Type-Options` and
`Referrer-Policy` as response headers — a meta CSP cannot express the first.

## Owned assets (no template material)

Everything the page shows is Demli's own and tracked in git; the publish guard
(`scripts/check-landing-dist.mjs`) refuses any build file that is neither a
Next build artefact nor tracked under `public/`.

| What | Where | Made by |
| --- | --- | --- |
| Phone screens | `public/images/shots/<hero\|voice\|screen\|table>-<tr\|en>.webp` | `scripts/gen-landing-shots.mjs` — headless captures of the real components via the apps/web harness pages |
| Phone bezel | `src/components/molecules/PhoneMockup.tsx` | CSS |
| Light rays / footer glow | `src/components/atoms/LightRays.tsx` + `globals.css` | CSS (reduced-motion aware) |
| Film grain | `public/images/grain.png` | `scripts/gen-landing-noise.mjs` (seeded) |
| Dot grid | `.dot-grid` in `globals.css` | CSS |
| Icons | `public/glyphs/*.svg` | hand-authored SVG |
| Review avatars | `TrustBadge.tsx` | initials on CSS gradients |

Re-render the screens after a UI change: `npx -y -p playwright-core@1.48.2 node scripts/gen-landing-shots.mjs`.

## Brand assets

`src/assets/demli-mark-256.png` and `public/{favicon.ico,favicon-32x32.png,apple-touch-icon.png}`
are derived from the single brand source `assets/brand/logo.png` (1024² RGBA) with
`sharp`, matching how `scripts/gen-icons.mjs` derives every other surface:

```
mark   sharp(logo).resize(256).png({ compressionLevel: 9, palette: true })
fav32  sharp(logo).resize(32).png({ compressionLevel: 9, palette: true })
ico    png-to-ico([48, 32, 16])
apple  sharp(logo).resize(180, { fit: "cover" }).flatten({ background: "#1a0806" })   # iOS ignores alpha
```

**Follow-up for devops:** fold these four outputs into `scripts/gen-icons.mjs` so
a re-brand stays the documented one-file swap. They are committed, so nothing
breaks until then.
