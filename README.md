# TubeDeck MP3

Compact Windows-focused Electron app for previewing YouTube videos and downloading MP3 files with clean filenames, embedded artwork, persistent history, and resilient recovery after interrupted sessions.

## Features

- Preview YouTube metadata before downloading
- Download MP3 files with clean title-based filenames
- Embed thumbnail artwork into MP3 metadata for phone and music-player cover art
- Keep a local download history with quick reveal/open actions
- Recover interrupted downloads into history on next launch
- Store logs in the background with quick folder access
- Package as a standalone Windows desktop app

## Stack

- Electron
- `yt-dlp-wrap`
- `ffmpeg-static`
- `electron-log`

## Project Layout

```text
electron/
  main.js        Electron main process and IPC registration
  preload.js     Renderer-safe API bridge
renderer/
  index.html     App shell
  app.js         Renderer state and UI updates
  styles.css     Compact desktop UI styling
src/main/
  downloader.js  yt-dlp + ffmpeg orchestration
  ffmpeg.js      ffmpeg resolution and runtime download fallback
  logger.js      JSONL event logging
  store.js       Versioned persisted app state
```

## Development

Install dependencies:

```bash
npm install
```

Start the app in development mode:

```bash
npm start
```

## Build

Create the unpacked Windows app:

```bash
npm run build
```

Run the packaged executable:

```powershell
.\dist\win-unpacked\TubeDeck MP3.exe
```

Create installer targets on Windows:

```bash
npm run build:installer
```

## Runtime Data

The app stores runtime data inside Electron's `userData` directory:

- `state.json` for settings, history, and interrupted-download recovery state
- `logs/app.log` for file logs
- `logs/events.jsonl` for structured event entries
- `bin/` for downloaded runtime tools such as `yt-dlp` and Windows `ffmpeg.exe`

## Resilience Notes

- Active downloads are persisted while they are running
- If the app closes unexpectedly, interrupted downloads are recovered into history on next launch
- State writes are atomic to reduce the chance of corruption after crashes or forced exits
- ffmpeg is resolved from the bundled binary first and downloaded at runtime on Windows if needed

## Limitations

- Interrupted downloads are recovered into history, but they are not automatically resumed
- The app targets YouTube URLs only
- Windows packaging is the primary supported distribution path

## License

[MIT](./LICENSE)
