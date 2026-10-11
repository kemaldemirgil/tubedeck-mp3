# TubeDeck MP3

A compact Windows desktop app for finding music on YouTube, listening before downloading, and saving verified MP3 files with clean filenames and embedded artwork.

## Everyday use

- Search for a song or artist, or paste a YouTube video link. Search uses the installed yt-dlp downloader; no YouTube Data API key is required.
- Choose a result to load its YouTube player. Use its play/pause, seek, and volume controls to check the version before clicking **Download MP3**.
- Playlist links ask whether to preview **This video** or **Choose tracks**. Playlist selection shows up to 100 tracks and starts with nothing selected.
- Use **Add multiple links** for one video URL per line, up to 100 at a time.
- Expand **Edit tags & artwork** to change the title, artist, album, or cover image. The filename preview reflects your title; existing files receive a numeric suffix.
- Choose **High quality** (VBR 0), **Balanced** (VBR 2), or **Small file** (128 kbps).
- Previously downloaded videos offer **Play MP3**, **Show file**, and **Download again**. Deleted or moved files can be downloaded again.
- Queue controls pause pending jobs, reorder waiting jobs, cancel downloads, and continue interrupted work. Settings allow 1–3 simultaneous downloads.
- Recent downloads group repeated attempts and expose **Retry** and **Details**. Logs remain in the background, accessible from Settings.
- **Ctrl+L** focuses search. **Ctrl+Enter** downloads the selected video. The Paste button also recognizes multiple lines.
- Settings include optional completion notifications, tool repair, diagnostics, and app updates when the build has an update feed.
- The window remembers its normal size and position and restores to a visible display.

Search results can differ from personalized YouTube results. Some videos do not permit embedded playback or require signing in; use **Open in YouTube** when playback is unavailable. The embedded player stays visible and retains YouTube controls.

## Reliability

Each job has a private working folder. The downloader preserves partial files for retries and recovery, uses bounded retries with increasing delays for temporary connection failures, and pauses the queue on YouTube rate limits.

Cancellation, inactivity timeouts, and shutdown stop the job's tool processes before releasing its workspace. On Windows this includes descendant processes, so FFmpeg cannot keep writing into a job that is about to resume.

A successful process exit alone does not count as a completed download. Before publishing the output, TubeDeck checks for readable MP3 audio, verifies the requested title/artist/album and cover artwork, and decodes the audio to detect errors. Final files are published without overwriting existing files. On Windows NTFS, publication uses an exclusive hard link to the verified staged file.

After an interrupted session, pending jobs and their quality, metadata, folder, and working files are restored. Click **Continue downloads** to resume. The durable saved-file library is separate from the 40-entry recent-history list. Existing version-2 settings, history, and interrupted jobs migrate automatically.

## Development

Requires Node.js and npm. In Windows PowerShell, use npm.cmd if script execution policy blocks npm.ps1.

```powershell
npm.cmd install
npm.cmd start
npm.cmd test
```

The tests cover store migrations, queue persistence/concurrency/recovery, download validation with real FFmpeg fixtures, error timing, and the Electron interface using Playwright. Search and YouTube playback are controlled fixtures in the desktop test; real FFmpeg, tags, artwork, and local playback are exercised.

An optional network smoke check searches YouTube, previews the short "Me at the zoo" video, attempts embedded playback, downloads and verifies an MP3, and plays it locally. It uses an isolated temporary profile/output folder and removes them afterwards.

```powershell
npm.cmd run smoke:live
```

Set TUBEDECK_YTDLP_SOURCE to an existing yt-dlp.exe to reuse it. Set TUBEDECK_EXECUTABLE to the packaged executable to test the packaged app. Set TUBEDECK_USER_DATA only when deliberately using an isolated profile; normal launches keep Electron's standard user-data location.

## Windows builds

```powershell
npm.cmd run build
.\dist\win-unpacked\TubeDeck MP3.exe
npm.cmd run build:installer
```

The ordinary development build is unsigned. FFmpeg and FFprobe are bundled and unpacked for Windows; yt-dlp is downloaded on first use and checks for updates once per session. Tool repair checks versions, refreshes yt-dlp, replaces an unusable downloader, and validates the audio tools. Offline update checks retain an installed downloader.

## Signed releases and app updates

The updater uses an HTTPS generic update feed and verifies the configured Windows publisher. Downloading and installing an app update are explicit actions in Settings. Existing downloads are saved before restarting.

A signed distributable requires your certificate and update hosting. Configure these environment variables without committing credentials:

- CSC_LINK: signing certificate file or the certificate reference supported by electron-builder.
- CSC_KEY_PASSWORD: signing certificate password.
- TUBEDECK_PUBLISHER_NAME: certificate publisher name, used to verify updates.
- TUBEDECK_UPDATE_URL: HTTPS base URL for the update feed.

Then run:

```powershell
npm.cmd run build:release
```

The release command requires all four variables and enforces code signing. It produces a signed NSIS installer and update artifacts, but does not upload them. Publish the generated installer, blockmap, and latest.yml together at the configured feed URL. Builds without a configured feed show that updates are unavailable; they do not query an invented server.

## Project layout

- electron/main.js: window lifecycle, notifications, validated IPC, and bootstrapping.
- electron/preload.js: explicit renderer bridge.
- renderer/app.js and styles.css: compact search, player, queue, and history interface.
- renderer/player.html and player.js: isolated YouTube player page, without the preload bridge.
- src/main/downloader.js: persistent queue, download stages, retries, recovery, and publication.
- src/main/youtube.js: yt-dlp setup, search, playlists, and metadata.
- src/main/audio.js: MP3 tagging, artwork, and validation.
- src/main/process.js: cancellable tool execution and Windows process-tree cleanup.
- src/main/media.js: URL normalization, video identity, filenames, and presets.
- src/main/store.js: versioned state, settings, history, and saved-file library.
- src/main/player-server.js: token-protected loopback player, artwork, and range-capable MP3 streaming.
- src/main/updates.js: configured app-update lifecycle.
- src/main/ffmpeg.js and logger.js: audio-tool resolution and background logging.

Runtime data lives in Electron's userData directory: state.json, logs/, bin/, jobs/, and imported covers/. Do not commit runtime data, node_modules/, dist/, or smoke-test artifacts. Commit package-lock.json.

## License

[MIT](./LICENSE)
