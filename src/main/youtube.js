const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const YTDlpWrap = require("yt-dlp-wrap").default;
const {
  youtubeUrl,
  watchUrl,
  durationLabel,
  safeImageUrl,
  VIDEO_ID,
} = require("./media");
const createYouTubeService = ({ app, logger, onLogEntry = () => {} }) => {
  const binDirectory = path.join(app.getPath("userData"), "bin");
  const binaryPath = path.join(
    binDirectory,
    process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
  );
  const runtimeArgs = [
    "--ignore-config",
    "--js-runtimes",
    `node:${process.execPath}`,
  ];
  const environment = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  let ready;
  const log = (level, event, metadata) =>
    onLogEntry(logger[level](event, metadata));
  const exec = (args, timeout = 60000) =>
    new Promise((resolve, reject) => {
      execFile(
        binaryPath,
        args,
        {
          windowsHide: true,
          timeout,
          maxBuffer: 12 * 1024 * 1024,
          env: environment,
        },
        (error, stdout, stderr) => {
          if (error)
            reject(new Error(String(stderr || error.message).slice(-5000)));
          else resolve(stdout);
        },
      );
    });
  const prepare = async () => {
    fs.mkdirSync(binDirectory, { recursive: true });
    if (!fs.existsSync(binaryPath)) {
      log("info", "downloader.binary.download.started", {});
      const temporary = `${binaryPath}.download`;
      await YTDlpWrap.downloadFromGithub(temporary);
      fs.renameSync(temporary, binaryPath);
    }
    if (process.platform !== "win32") fs.chmodSync(binaryPath, 0o755);
    try {
      log("info", "downloader.binary.update.started", {});
      await exec(["--update"], 20000);
      log("info", "downloader.binary.update.completed", {});
    } catch (error) {
      log("warn", "downloader.binary.update.failed", {
        message: error.message,
      });
    }
    return binaryPath;
  };
  const ensure = () =>
    (ready ||= prepare().catch((error) => {
      ready = null;
      throw error;
    }));
  const run = async (args) => {
    await ensure();
    return exec([...runtimeArgs, ...args]);
  };
  const normalize = (data) => ({
    id: data.id,
    url: watchUrl(data.id),
    title: data.title || "Untitled video",
    uploader: data.uploader || data.channel || "Unknown channel",
    artist: data.artist || data.creator || "",
    album: data.album || "",
    duration: data.duration || 0,
    durationLabel: durationLabel(data.duration),
    thumbnail: safeImageUrl(
      data.thumbnail ||
        data.thumbnails?.at(-1)?.url ||
        `https://i.ytimg.com/vi/${data.id}/hqdefault.jpg`,
    ),
    viewCount: data.view_count || 0,
    description: data.description || "",
  });
  return {
    ensure,
    run,
    runtimeArgs,
    environment,
    binaryPath,
    repair: async () => {
      ready = null;
      await ensure();
      try {
        return (await exec(["--version"], 10000)).trim();
      } catch {
        const temporary = `${binaryPath}.download`;
        await YTDlpWrap.downloadFromGithub(temporary);
        if (process.platform !== "win32") fs.chmodSync(temporary, 0o755);
        fs.renameSync(temporary, binaryPath);
        return (await exec(["--version"], 10000)).trim();
      }
    },
    version: async () => {
      await ensure();
      return (await exec(["--version"], 10000)).trim();
    },
    fetchPreview: async (input) =>
      normalize(
        JSON.parse(
          await run([
            "--dump-single-json",
            "--no-playlist",
            "--skip-download",
            youtubeUrl(input).href,
          ]),
        ),
      ),
    search: async (query, count = 12) => {
      const text = String(query || "")
        .trim()
        .slice(0, 200);
      if (!text) throw new Error("Enter a song or artist to search.");
      const data = JSON.parse(
        await run([
          "--dump-single-json",
          "--flat-playlist",
          "--skip-download",
          `ytsearch${Math.min(48, Math.max(12, Number(count) || 12))}:${text}`,
        ]),
      );
      return (data.entries || [])
        .filter((entry) => VIDEO_ID.test(entry.id) && !entry.is_live)
        .map(normalize);
    },
    playlist: async (input) => {
      const id = youtubeUrl(input).searchParams.get("list");
      if (!id || !/^[\w-]+$/.test(id))
        throw new Error("This link does not contain a playlist.");
      const data = JSON.parse(
        await run([
          "--dump-single-json",
          "--flat-playlist",
          "--skip-download",
          "--playlist-end",
          "100",
          `https://www.youtube.com/playlist?list=${id}`,
        ]),
      );
      return {
        title: data.title || "Playlist",
        results: (data.entries || [])
          .filter((entry) => VIDEO_ID.test(entry.id) && !entry.is_live)
          .map(normalize),
        limited: (data.entries || []).length >= 100,
      };
    },
  };
};
module.exports = { createYouTubeService };
