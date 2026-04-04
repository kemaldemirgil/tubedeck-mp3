const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");
const YTDlpWrap = require("yt-dlp-wrap").default;
const { createFfmpegManager } = require("./ffmpeg");

const parseJson = (value) => JSON.parse(value);

const ensureHttpUrl = (rawUrl) => {
  const input = (rawUrl || "").trim();

  if (!input) {
    throw new Error("Paste a YouTube URL first.");
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch (_error) {
    throw new Error("That URL is not valid.");
  }

  if (!["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(parsed.hostname)) {
    throw new Error("Only YouTube URLs are supported.");
  }

  return parsed.toString();
};

const formatEta = (seconds) => {
  if (!seconds && seconds !== 0) {
    return "";
  }

  const totalSeconds = Number(seconds);
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "";
  }

  const minutes = Math.floor(totalSeconds / 60);
  const remainder = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
};

const slugDuration = (seconds) => {
  if (!Number.isFinite(seconds)) {
    return "Unknown";
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }

  return `${minutes}:${String(remainder).padStart(2, "0")}`;
};

const parseProgressLine = (line) => {
  const match = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+(.+?)\s+at\s+(.+?)\s+ETA\s+(.+)/i);
  if (!match) {
    return null;
  }

  return {
    progressPercent: Number(match[1]),
    totalSize: match[2].trim(),
    speed: match[3].trim(),
    eta: match[4].trim()
  };
};

const summarizeError = (rawMessage) => {
  const message = rawMessage || "Unknown download error.";

  if (/Video unavailable/i.test(message)) {
    return "This video is unavailable.";
  }

  if (/Sign in to confirm your age/i.test(message)) {
    return "This video is age-restricted and cannot be downloaded anonymously.";
  }

  if (/Unsupported URL/i.test(message)) {
    return "The provided URL is not supported.";
  }

  if (/HTTP Error 429/i.test(message)) {
    return "YouTube rate-limited the request. Wait a bit and try again.";
  }

  if (/ffmpeg/i.test(message)) {
    return "ffmpeg is not available, so audio conversion could not start.";
  }

  return message.split("\n").find(Boolean) || message;
};

const WINDOWS_RESERVED_FILE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const sanitizeFileName = (value) => {
  // Keep output names readable while removing characters Windows rejects.
  const sanitized = (value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  if (!sanitized) {
    return "TubeDeck MP3";
  }

  const limited = sanitized.slice(0, 140).trim().replace(/[. ]+$/g, "");
  if (!limited) {
    return "TubeDeck MP3";
  }

  return WINDOWS_RESERVED_FILE_NAMES.test(limited) ? `${limited}_` : limited;
};

const createOutputTemplate = (outputDirectory, preferredTitle) => {
  const fallbackTemplate = path.join(outputDirectory, "%(title).140B.%(ext)s");

  if (!preferredTitle) {
    return {
      template: fallbackTemplate,
      plannedOutputPath: ""
    };
  }

  const baseName = sanitizeFileName(preferredTitle);
  let candidateName = baseName;
  let suffix = 2;

  while (fs.existsSync(path.join(outputDirectory, `${candidateName}.mp3`))) {
    // Avoid clobbering an existing file when users download the same title repeatedly.
    candidateName = `${baseName} (${suffix})`;
    suffix += 1;
  }

  return {
    template: path.join(outputDirectory, `${candidateName}.%(ext)s`),
    plannedOutputPath: path.join(outputDirectory, `${candidateName}.mp3`)
  };
};

const toSerializableDownload = (download) => ({
  id: download.id,
  url: download.url,
  title: download.title,
  uploader: download.uploader,
  thumbnail: download.thumbnail,
  duration: download.duration,
  status: download.status,
  progressPercent: download.progressPercent || 0,
  speed: download.speed || "",
  eta: download.eta || "",
  outputDirectory: download.outputDirectory,
  outputPath: download.outputPath || "",
  startedAt: download.startedAt,
  completedAt: download.completedAt || null,
  errorMessage: download.errorMessage || "",
  trace: download.trace.slice(-12)
});

const toPersistentDownload = (download) => ({
  ...toSerializableDownload(download),
  videoId: download.videoId || "",
  plannedOutputPath: download.plannedOutputPath || ""
});

const resolveFinalOutputPath = (outputDirectory, { plannedOutputPath = "", videoId = "" } = {}) => {
  if (plannedOutputPath && fs.existsSync(plannedOutputPath)) {
    return plannedOutputPath;
  }

  if (!fs.existsSync(outputDirectory)) {
    return "";
  }

  if (!videoId) {
    return "";
  }

  const match = fs
    .readdirSync(outputDirectory)
    .find((fileName) => fileName.endsWith(".mp3") && fileName.includes(`[${videoId}]`));

  return match ? path.join(outputDirectory, match) : "";
};

const createDownloaderService = ({
  app,
  logger,
  store,
  onDownloadUpdate,
  onHistoryUpdate,
  onLogEntry
}) => {
  const binDirectory = path.join(app.getPath("userData"), "bin");
  const ytDlpPath = path.join(binDirectory, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  const downloads = new Map();
  const ffmpeg = createFfmpegManager({
    binDirectory,
    logger,
    onLogEntry
  });

  fs.mkdirSync(binDirectory, { recursive: true });
  const startupRecovery = {
    recoveredDownloads: 0
  };

  const emitLog = (level, event, metadata) => {
    const entry = logger[level](event, metadata);
    onLogEntry(entry);
    return entry;
  };

  const ensureExecutableBit = () => {
    if (process.platform !== "win32" && fs.existsSync(ytDlpPath)) {
      fs.chmodSync(ytDlpPath, 0o755);
    }
  };

  const ensureYtDlpBinary = async () => {
    if (fs.existsSync(ytDlpPath)) {
      ensureExecutableBit();
      return ytDlpPath;
    }

    emitLog("info", "downloader.binary.download.started", { target: ytDlpPath });
    await YTDlpWrap.downloadFromGithub(ytDlpPath);
    ensureExecutableBit();
    emitLog("info", "downloader.binary.download.completed", { target: ytDlpPath });
    return ytDlpPath;
  };

  const runYtDlp = async (args) => {
    const binaryPath = await ensureYtDlpBinary();

    return new Promise((resolve, reject) => {
      execFile(binaryPath, args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          const details = stderr || stdout || error.message;
          reject(new Error(details));
          return;
        }

        resolve(stdout);
      });
    });
  };

  const emitDownload = (download) => {
    downloads.set(download.id, download);
    onDownloadUpdate(toSerializableDownload(download));
  };

  const persistActiveDownload = (download) => {
    // Persist only in-flight jobs; completed history already lives in state.history.
    if (["queued", "running"].includes(download.status)) {
      store.upsertActiveDownload(toPersistentDownload(download));
      return;
    }

    store.removeActiveDownload(download.id);
  };

  const persistHistory = (download) => {
    const historyItem = {
      id: download.id,
      url: download.url,
      title: download.title,
      uploader: download.uploader,
      thumbnail: download.thumbnail,
      duration: download.duration,
      status: download.status,
      progressPercent: download.progressPercent || 0,
      outputDirectory: download.outputDirectory,
      outputPath: download.outputPath || "",
      startedAt: download.startedAt,
      completedAt: download.completedAt || null,
      speed: download.speed || "",
      eta: download.eta || "",
      errorMessage: download.errorMessage || "",
      trace: download.trace.slice(-12)
    };

    store.upsertHistoryItem(historyItem);
    onHistoryUpdate(historyItem);
  };

  const appendTrace = (download, message, metadata = {}) => {
    download.trace.push({
      timestamp: new Date().toISOString(),
      message,
      metadata
    });
  };

  const markDownload = (download, patch) => {
    // History, live download state, and recovery state all derive from the same mutation point.
    Object.assign(download, patch);
    persistActiveDownload(download);
    emitDownload(download);
    persistHistory(download);
  };

  const recoverInterruptedDownloads = () => {
    // On startup, convert any persisted in-flight jobs into history entries with a recovered status.
    const interruptedDownloads = store.consumeInterruptedDownloads();
    startupRecovery.recoveredDownloads = interruptedDownloads.length;

    interruptedDownloads.forEach((download) => {
      const recoveredOutputPath = resolveFinalOutputPath(download.outputDirectory, {
        plannedOutputPath: download.plannedOutputPath,
        videoId: download.videoId
      });
      const completed = Boolean(recoveredOutputPath);
      const recoveredHistoryItem = {
        ...download,
        status: completed ? "completed" : "failed",
        progressPercent: completed ? 100 : download.progressPercent || 0,
        outputPath: recoveredOutputPath,
        completedAt: new Date().toISOString(),
        errorMessage: completed ? "" : "Download was interrupted when the app closed.",
        trace: Array.isArray(download.trace)
          ? download.trace.slice(-12)
          : []
      };

      store.upsertHistoryItem(recoveredHistoryItem);

      emitLog(completed ? "info" : "warn", completed ? "download.recovered.completed" : "download.recovered.interrupted", {
        id: recoveredHistoryItem.id,
        title: recoveredHistoryItem.title,
        outputPath: recoveredOutputPath
      });
    });
  };

  recoverInterruptedDownloads();

  return {
    warmup: async () => {
      await ensureYtDlpBinary();
      await ffmpeg.ensureFfmpegBinary();
    },
    getStartupRecovery: () => ({ ...startupRecovery }),
    getDownloads: () =>
      Array.from(downloads.values())
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .map((download) => toSerializableDownload(download)),
    fetchPreview: async (rawUrl) => {
      const url = ensureHttpUrl(rawUrl);

      emitLog("info", "preview.requested", { url });

      try {
        const stdout = await runYtDlp([
          "--dump-single-json",
          "--no-playlist",
          "--skip-download",
          url
        ]);

        const data = parseJson(stdout);
        const preview = {
          id: data.id,
          url,
          title: data.title,
          uploader: data.uploader || data.channel || "Unknown uploader",
          duration: data.duration || 0,
          durationLabel: slugDuration(data.duration || 0),
          thumbnail: data.thumbnail || "",
          viewCount: data.view_count || 0,
          description: data.description || "",
          uploadDate: data.upload_date || "",
          webpageUrl: data.webpage_url || url
        };

        emitLog("info", "preview.completed", {
          url,
          videoId: preview.id,
          title: preview.title
        });

        return preview;
      } catch (error) {
        const message = summarizeError(error.message);
        emitLog("error", "preview.failed", { url, message });
        throw new Error(message);
      }
    },
    startDownload: async ({ url: rawUrl, preview, outputDirectory }) => {
      const url = ensureHttpUrl(rawUrl);
      const targetDirectory = outputDirectory || store.getSettings().outputDirectory;
      const binaryPath = await ensureYtDlpBinary();
      const ffmpegBinaryPath = await ffmpeg.ensureFfmpegBinary();
      fs.mkdirSync(targetDirectory, { recursive: true });
      const outputPlan = createOutputTemplate(targetDirectory, preview?.title);

      const download = {
        id: `job-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        videoId: preview?.id || "",
        url,
        title: preview?.title || "Resolving video…",
        uploader: preview?.uploader || "",
        thumbnail: preview?.thumbnail || "",
        duration: preview?.durationLabel || "",
        status: "queued",
        progressPercent: 0,
        speed: "",
        eta: "",
        outputDirectory: targetDirectory,
        outputPath: "",
        plannedOutputPath: outputPlan.plannedOutputPath,
        startedAt: new Date().toISOString(),
        completedAt: null,
        errorMessage: "",
        trace: [],
        child: null,
        settled: false,
        cancelRequested: false
      };

      appendTrace(download, "Download requested.", { outputDirectory: targetDirectory });
      markDownload(download, {});
      emitLog("info", "download.started", {
        id: download.id,
        url,
        outputDirectory: targetDirectory
      });

      const args = [
        "--newline",
        "--no-playlist",
        "--no-warnings",
        "--extract-audio",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "0",
        "--embed-metadata",
        "--embed-thumbnail",
        "--convert-thumbnails",
        "jpg",
        "--ffmpeg-location",
        ffmpegBinaryPath,
        "-o",
        outputPlan.template,
        url
      ];

      // Use spawn here so progress can stream back into the compact renderer in real time.
      const child = spawn(binaryPath, args, { windowsHide: true });
      download.child = child;
      downloads.set(download.id, download);
      markDownload(download, { status: "running" });

      let combinedError = "";
      let stdoutBuffer = "";
      let stderrBuffer = "";

      const finalize = (patch, logLevel, event, metadata) => {
        if (download.settled) {
          return;
        }

        download.settled = true;
        download.child = null;
        markDownload(download, patch);
        emitLog(logLevel, event, metadata);
      };

      const processLine = (rawLine, source) => {
        const line = rawLine.trim();
        if (!line) {
          return;
        }

        appendTrace(download, line, { source });

        // yt-dlp and ffmpeg emit progress as plain text, so the app derives state from line parsing.
        const progress = parseProgressLine(line);
        if (progress) {
          markDownload(download, {
            progressPercent: progress.progressPercent,
            speed: progress.speed,
            eta: progress.eta
          });
          return;
        }

        if (path.isAbsolute(line) && line.toLowerCase().endsWith(".mp3")) {
          markDownload(download, {
            outputPath: line
          });
          return;
        }

        const destinationMatch = line.match(/Destination:\s(.+\.mp3)$/i);
        if (destinationMatch) {
          markDownload(download, {
            outputPath: destinationMatch[1]
          });
          return;
        }
      };

      const consumeStream = (chunk, source) => {
        const output = chunk.toString();
        let buffer = source === "stdout" ? stdoutBuffer : stderrBuffer;

        if (source === "stderr") {
          combinedError += output;
        }

        buffer += output;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        lines.forEach((line) => processLine(line, source));

        if (source === "stdout") {
          stdoutBuffer = buffer;
        } else {
          stderrBuffer = buffer;
        }
      };

      child.stdout.on("data", (chunk) => {
        consumeStream(chunk, "stdout");
      });

      child.stderr.on("data", (chunk) => {
        consumeStream(chunk, "stderr");
      });

      child.on("error", (error) => {
        const message = summarizeError(error.message);
        appendTrace(download, message, { source: "process" });
        finalize({
          status: "failed",
          errorMessage: message,
          completedAt: new Date().toISOString()
        }, "error", "download.process.error", {
          id: download.id,
          message
        });
      });

      child.on("close", (code) => {
        if (stdoutBuffer.trim()) {
          processLine(stdoutBuffer, "stdout");
        }

        if (stderrBuffer.trim()) {
          processLine(stderrBuffer, "stderr");
        }

        if (download.settled) {
          return;
        }

        if (download.cancelRequested) {
          finalize({
            status: "canceled",
            completedAt: new Date().toISOString(),
            errorMessage: ""
          }, "warn", "download.canceled", {
            id: download.id
          });
          return;
        }

        if (code === 0) {
          // Prefer the planned output path when it exists so clean filenames survive post-processing steps.
          const finalPath = download.outputPath || resolveFinalOutputPath(targetDirectory, {
            plannedOutputPath: download.plannedOutputPath,
            videoId: download.videoId
          }) || targetDirectory;
          finalize({
            status: "completed",
            progressPercent: 100,
            eta: formatEta(0),
            completedAt: new Date().toISOString(),
            outputPath: finalPath
          }, "info", "download.completed", {
            id: download.id,
            outputPath: finalPath
          });
          return;
        }

        const message = summarizeError(combinedError);
        finalize({
          status: "failed",
          errorMessage: message,
          completedAt: new Date().toISOString()
        }, "error", "download.failed", {
          id: download.id,
          message
        });
      });

      return {
        id: download.id,
        status: "running"
      };
    },
    cancelDownload: async (downloadId) => {
      const download = downloads.get(downloadId);
      if (!download || !download.child) {
        return { ok: false };
      }

      download.cancelRequested = true;
      download.child.kill("SIGTERM");
      appendTrace(download, "Download canceled by the user.");
      return { ok: true };
    }
  };
};

module.exports = {
  createDownloaderService
};
