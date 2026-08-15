# app/ — Rook

**Not started.** This directory will hold the Tauri app that turns the engine from
"a thing you run in a terminal" into "a thing that's just always there."

## What it does

- Lives in the Windows tray / macOS menu bar
- Starts the engine at login and supervises it (restart on crash)
- Shows the one status that matters: **which device inference is on**, so a silent CPU
  fallback is visible at a glance rather than discovered as mysterious slowness
- Small settings panel — default voice, port, token, start-at-login
- Ships the installers: `.exe` (NSIS) for Windows, `.dmg` for macOS

## Why Tauri rather than Electron

Rook's UI is a tray icon, a menu, and one small window. Electron would add ~150 MB and a
bundled Node runtime to that, and **the Node runtime is the part we don't need** — the
engine is Python, and the only JavaScript in CORVVS is the `corvvs` client, which runs in
*consumer* projects, not here. Tauri lands around 8 MB with first-class tray support on
both targets.

Cost: building Rook needs the Rust toolchain. Running it needs nothing.

## Installer strategy

PyTorch's Windows CUDA build is ~2.5 GB, so it can't sensibly ship inside the installer.
The installer stays small and **the first launch shows progress** while it runs the same
work `scripts/setup.mjs` does — fetching a private Python, the right PyTorch, and the
model.

macOS is much lighter: Apple Silicon GPU support is in the stock PyTorch wheel, so
there's no CUDA download and no hardware-matching guesswork. Expect ~1.5 GB and a
simpler path.

## Scaffolding it

```bash
npm create tauri-app@latest app -- --template vanilla
```

Rust 1.84 and `uv` are already present on the dev machine, so there's nothing else to
install first.

## Open questions

- **Does Rook own setup, or delegate to `scripts/setup.mjs`?** Sharing the script keeps
  one code path for the hardest part of the install, which argues for delegation — Rook
  runs it and renders the output.
- **Auto-update.** Tauri has an updater plugin, but it needs a signing key and a release
  feed. Probably worth it before any non-technical user installs this; not before.
- **Port conflicts.** If VESTA's own Kokoro server is still running on 8765, Rook needs to
  detect that and say so plainly rather than failing to bind. Goes away once VESTA is
  migrated to consume `corvvs`.
