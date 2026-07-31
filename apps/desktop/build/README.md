# Desktop installer assets (electron-builder `buildResources`)

electron-builder reads this directory (`directories.buildResources: build` in
`../electron-builder.yml`) for branding and installer assets. Files here are
**not** packed into the app — they are used at build time to brand the exe,
the installer and the shortcuts. Anything the app needs at RUNTIME (the tray
icon, the window icon) is embedded as base64 in `../src/main/tray-icon.ts`
instead, because electron-builder only packs `out/` + `package.json`.

## Everything here is generated — do not hand-edit

| File                         | Purpose                                                  |
| ---------------------------- | -------------------------------------------------------- |
| `icon.ico`                   | App exe icon, installer icon, Start-menu/desktop shortcut (256…16px) |
| `icon.png`                   | 512px app/installer icon (macOS + Linux targets)          |
| `tray-icon.png` / `-16.png`  | Windows system-tray mark at 32 / 16px                     |
| `tray-icon-unread*.png`      | Same marks with the red unread dot                        |
| `taskbar-unread-badge.png`   | Standalone dot for `BrowserWindow.setOverlayIcon`         |

All of them derive from the single brand source `assets/brand/logo.png` via:

```bash
pnpm gen:icons          # regenerate every surface (desktop, mobile, web, landing)
pnpm test:brand         # verify the committed files against brand-manifest.json
```

Sizes and per-surface safe areas are declared in
`assets/brand/brand-manifest.json`; `pnpm lint` runs the check, so a
hand-edited or stale icon fails the build rather than shipping quietly.

## Optional NSIS extras (not generated, drop in by hand)

| File                  | Purpose                              | Requirements   |
| --------------------- | ------------------------------------ | -------------- |
| `installerIcon.ico`   | distinct NSIS installer icon         | `.ico`, 256×256 |
| `uninstallerIcon.ico` | distinct uninstaller icon            | `.ico`, 256×256 |
| `installerHeader.bmp` | NSIS header image                    | 150×57 BMP     |
| `installer.nsh`       | custom NSIS include (advanced UX)    | NSIS script    |
