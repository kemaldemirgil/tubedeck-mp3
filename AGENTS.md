# AGENTS.md

This repository is a compact Electron desktop app for previewing YouTube videos and downloading MP3 files.

## Working Principles

- Keep the UI compact. Do not reintroduce large dashboard-style layouts.
- Prefer small, focused changes over broad rewrites.
- Preserve the clean filename and embedded-artwork behavior in the download pipeline.
- Keep logs background-oriented. Do not restore a large on-screen trace log unless explicitly requested.
- When editing, maintain Windows-first behavior unless there is a clear reason to generalize.

## Architecture Notes

- `electron/main.js` owns window creation, IPC, and app bootstrapping.
- `electron/preload.js` is the only renderer bridge. Keep it narrow and explicit.
- `src/main/store.js` owns persisted state and migration-safe normalization.
- `src/main/downloader.js` owns previewing, downloading, filename planning, and interrupted-download recovery.
- `src/main/ffmpeg.js` resolves or downloads ffmpeg.
- `src/main/logger.js` writes structured JSONL event logs plus the standard Electron log file.
- `renderer/app.js` contains all renderer-side state and rendering logic.
- `renderer/styles.css` is intentionally compact and utility-app oriented.

## Repo Hygiene

- Commit `package-lock.json`.
- Do not commit `dist/`, `node_modules/`, runtime logs, or smoke-test temp directories.
- Keep README accurate when behavior changes.
- If state shape changes, update migrations in `src/main/store.js`.

## Safe Change Checklist

- If download payloads change, verify renderer bootstrap and history rendering still work.
- If persistence changes, verify recovery behavior after an interrupted download.
- If packaging changes, run `npm run build`.
- Prefer adding succinct comments only where the lifecycle or failure mode is non-obvious.
