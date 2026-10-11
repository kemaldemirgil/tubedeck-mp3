const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  stopProcessTree,
  waitForProcessStop,
  waitWithSignal,
} = require("./process");
const { createYouTubeService } = require("./youtube");
const { createFfmpegManager } = require("./ffmpeg");
const audio = require("./audio");
const {
  youtubeUrl,
  videoId,
  watchUrl,
  normalizeMetadata,
  sanitizeFileName,
  QUALITY_PRESETS,
} = require("./media");

const ACTIVE = [
  "queued",
  "preparing",
  "downloading",
  "converting",
  "verifying",
  "retrying",
  "interrupted",
];
const summarizeError = (raw) => {
  const message = String(raw || "The download could not finish.");
  if (/429|too many requests/i.test(message))
    return "YouTube is rate-limiting requests. The queue is paused; try again shortly.";
  if (/403|forbidden/i.test(message))
    return "YouTube rejected this download. Check and repair download tools in Settings, then retry.";
  if (/sign in|age.restrict/i.test(message))
    return "This video requires signing in and cannot be downloaded anonymously.";
  if (/unavailable|private video|removed|not available/i.test(message))
    return "This video is unavailable.";
  if (/ENOSPC|no space left|disk full/i.test(message))
    return "There is not enough free space in the download folder.";
  if (/EACCES|EPERM|permission denied/i.test(message))
    return "TubeDeck cannot write to this folder. Choose a different output folder.";
  return (
    message.split(/\r?\n/).find((line) => /^ERROR:/i.test(line)) || message
  ).slice(0, 350);
};
const transient = (message) =>
  /timed? out|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|connection|HTTP Error 5\d\d/i.test(
    message,
  );
const createDownloaderService = ({
  app,
  logger,
  store,
  onDownloadUpdate = () => {},
  onHistoryUpdate = () => {},
  onLogEntry = () => {},
  onLibraryUpdate = () => {},
  youtube: providedYouTube,
  ffmpeg: providedFfmpeg,
  validateAudio = audio.validateAudio,
  tagAudio = audio.tagAudio,
  spawnProcess = spawn,
  retryDelays = [2000, 6000],
  inactivityTimeout = 180000,
}) => {
  const youtube =
    providedYouTube || createYouTubeService({ app, logger, onLogEntry });
  const ffmpeg =
    providedFfmpeg ||
    createFfmpegManager({
      binDirectory: path.join(app.getPath("userData"), "bin"),
      logger,
      onLogEntry,
    });
  const jobsRoot = path.join(app.getPath("userData"), "jobs");
  fs.mkdirSync(jobsRoot, { recursive: true });
  const jobs = new Map();
  const executions = new Set();
  let running = 0,
    paused = false,
    closing = false,
    repaired = null;
  const serial = (job) => {
    const { child, timer, wakeRetry, abort, ...item } = job;
    return structuredClone(item);
  };
  const log = (level, event, metadata) =>
    onLogEntry(logger[level](event, metadata));
  const emit = (job, patch = {}) => {
    Object.assign(job, patch);
    const item = serial(job);
    if (ACTIVE.includes(job.status)) store.upsertActiveDownload(item);
    else store.removeActiveDownload(job.id);
    onDownloadUpdate(item);
  };
  const workspace = (job) => path.join(jobsRoot, job.id);
  const trace = (job, line) => {
    job.trace = [
      ...(job.trace || []),
      { timestamp: new Date().toISOString(), message: line },
    ].slice(-20);
  };
  const finish = (job, status, errorMessage = "") => {
    emit(job, {
      status,
      errorMessage,
      completedAt: new Date().toISOString(),
      progressPercent: status === "completed" ? 100 : job.progressPercent,
    });
    const item = serial(job);
    store.upsertHistoryItem(item);
    onHistoryUpdate(item);
    if (status === "completed") {
      store.upsertLibraryItem(item);
      onLibraryUpdate(getLibrary());
    }
    log(status === "failed" ? "error" : "info", "download." + status, {
      id: job.id,
      videoId: job.videoId,
      message: errorMessage,
    });
    // Only this job's generated workspace may be cleaned, after publishing a verified file.
    if (status === "completed") {
      try {
        fs.rmSync(workspace(job), { recursive: true, force: true });
      } catch (error) {
        log("warn", "download.workspace.cleanup.failed", {
          id: job.id,
          message: error.message,
        });
      }
    }
  };
  const getLibrary = () =>
    (store.getLibrary?.() || []).map((item) => ({
      ...item,
      available: (() => {
        try {
          return Boolean(
            item.outputPath && fs.statSync(item.outputPath).isFile(),
          );
        } catch {
          return false;
        }
      })(),
    }));
  const findExisting = (id) =>
    getLibrary().find((item) => item.videoId === id && item.available);
  const recovered =
    store.getActiveDownloads?.() || store.consumeInterruptedDownloads?.() || [];
  for (const item of recovered) {
    if (!/^[\w-]+$/.test(item.id)) continue;
    try {
      youtubeUrl(item.url);
      const job = {
        ...item,
        videoId: item.videoId || videoId(item.url),
        status: "interrupted",
        child: null,
        cancelRequested: false,
        trace: item.trace || [],
        errorMessage:
          "Interrupted when TubeDeck closed. Continue to resume this job.",
      };
      jobs.set(job.id, job);
      store.upsertActiveDownload(serial(job));
    } catch (error) {
      log("warn", "download.recovery.skipped", {
        id: item.id,
        message: error.message,
      });
    }
  }
  paused = recovered.length > 0;
  const startupRecovery = { recoveredDownloads: jobs.size };
  const progress = (job, line) => {
    trace(job, line);
    if (line.startsWith("TD_PROGRESS:")) {
      const [percent, speed, eta] = line.slice(12).split("|");
      const number = Number(percent.replace(/[^\d.]/g, ""));
      emit(job, {
        status: "downloading",
        progressPercent: Number.isFinite(number) ? Math.min(99, number) : 0,
        speed: speed || "",
        eta: eta || "",
      });
    } else if (
      /^\[(ExtractAudio|Metadata|EmbedThumbnail|ThumbnailsConvertor)\]/.test(
        line,
      )
    ) {
      emit(job, { status: "converting" });
    }
  };
  const downloadSource = async (job, ffmpegPath) => {
    const binary = await waitWithSignal(youtube.ensure(), job.abort.signal);
    if (job.cancelRequested || closing) return;
    const args = [
      ...youtube.runtimeArgs,
      "--newline",
      "--no-playlist",
      "--continue",
      "--no-overwrites",
      "--retries",
      "2",
      "--fragment-retries",
      "2",
      "--extractor-retries",
      "1",
      "--retry-sleep",
      "exp=1:8",
      "--abort-on-unavailable-fragments",
      "--socket-timeout",
      "20",
      "--progress-template",
      "download:TD_PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
      "--format",
      "bestaudio/best",
      "--extract-audio",
      "--audio-format",
      "mp3",
      "--audio-quality",
      QUALITY_PRESETS[job.quality] || "0",
      "--embed-metadata",
      "--embed-thumbnail",
      "--convert-thumbnails",
      "jpg",
      "--write-thumbnail",
      "--ffmpeg-location",
      ffmpegPath,
      "-o",
      path.join(workspace(job), "source.%(ext)s"),
      job.url,
    ];
    await new Promise((resolve, reject) => {
      const child = spawnProcess(binary, args, {
        windowsHide: true,
        env: youtube.environment,
      });
      job.child = child;
      let stdout = "",
        stderr = "",
        errors = "",
        timeoutError = null,
        settled = false;
      const done = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(job.timer);
        job.timer = null;
        job.child = null;
        if (error) reject(error);
        else resolve();
      };
      const armTimeout = () => {
        if (timeoutError || job.cancelRequested || closing) return;
        clearTimeout(job.timer);
        job.timer = setTimeout(() => {
          timeoutError = new Error(
            "The download timed out without making progress.",
          );
          void stopProcessTree(child);
        }, inactivityTimeout);
        job.timer.unref?.();
      };
      const consume = (chunk, source) => {
        armTimeout();
        const text = chunk.toString();
        if (source === "stderr") errors = (errors + text).slice(-12000);
        const lines = ((source === "stdout" ? stdout : stderr) + text).split(
          /\r?\n/,
        );
        const rest = lines.pop();
        if (source === "stdout") stdout = rest;
        else stderr = rest;
        lines.forEach((line) => progress(job, line.trim()));
      };
      child.stdout.on("data", (chunk) => consume(chunk, "stdout"));
      child.stderr.on("data", (chunk) => consume(chunk, "stderr"));
      child.once("error", (error) => done(error));
      child.once("close", async (code) => {
        await waitForProcessStop(child);
        if (stdout.trim()) progress(job, stdout.trim());
        if (stderr.trim()) trace(job, stderr.trim());
        done(
          job.cancelRequested || closing
            ? null
            : timeoutError ||
                (code === 0
                  ? null
                  : new Error(errors || "Downloader exited with code " + code)),
        );
      });
      armTimeout();
      emit(job, { status: "downloading" });
    });
  };
  const retryOperation = async (job, operation, stage) => {
    for (let attempt = 0; ; attempt++) {
      if (job.cancelRequested || closing) return false;
      try {
        emit(job, { status: stage, errorMessage: "" });
        await operation();
        return true;
      } catch (error) {
        trace(job, error.message);
        if (job.cancelRequested || closing) return false;
        if (/429|too many requests/i.test(error.message)) {
          paused = true;
          emit(job, {
            status: "interrupted",
            errorMessage: summarizeError(error.message),
          });
          return false;
        }
        if (!transient(error.message) || attempt >= retryDelays.length)
          throw error;
        emit(job, {
          status: "retrying",
          attempt: attempt + 1,
          errorMessage: "Connection interrupted. Retrying shortly.",
        });
        await new Promise((resolve) => {
          job.timer = setTimeout(resolve, retryDelays[attempt]);
          job.wakeRetry = resolve;
        });
        job.timer = null;
        delete job.wakeRetry;
      }
    }
  };
  const publish = (job, staged) => {
    fs.mkdirSync(job.outputDirectory, { recursive: true });
    const temporary = path.join(
      job.outputDirectory,
      ".tubedeck-" + job.id + ".tmp",
    );
    fs.copyFileSync(staged, temporary);
    const base = sanitizeFileName(job.metadata.title);
    let destination;
    for (let suffix = 1; ; suffix++) {
      destination = path.join(
        job.outputDirectory,
        base + (suffix > 1 ? " (" + suffix + ")" : "") + ".mp3",
      );
      try {
        // An exclusive hard link publishes the verified file atomically on Windows NTFS.
        fs.linkSync(temporary, destination);
        break;
      } catch (error) {
        if (error.code === "EEXIST") continue;
        if (!["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error.code))
          throw error;
        try {
          fs.copyFileSync(temporary, destination, fs.constants.COPYFILE_EXCL);
          break;
        } catch (copyError) {
          if (copyError.code !== "EEXIST") throw copyError;
        }
      }
    }
    fs.unlinkSync(temporary);
    return destination;
  };
  const runJob = async (job) => {
    job.abort = new AbortController();
    try {
      emit(job, { status: "preparing", errorMessage: "" });
      fs.mkdirSync(workspace(job), { recursive: true });
      let ffmpegPath;
      if (
        !(await retryOperation(
          job,
          async () => {
            ffmpegPath = await waitWithSignal(
              ffmpeg.ensureFfmpegBinary(),
              job.abort.signal,
            );
            const preview =
              job.preview?.duration > 0
                ? job.preview
                : await youtube.fetchPreview(job.url, job.abort.signal);
            job.preview = preview;
            job.videoId = preview.id;
            job.title = job.metadata?.title || preview.title;
            job.metadata = normalizeMetadata(job.metadata || {}, preview);
            job.uploader = preview.uploader;
            job.thumbnail = preview.thumbnail;
            job.duration = preview.durationLabel;
          },
          "preparing",
        ))
      )
        return;
      if (job.cancelRequested || closing) return;
      if (
        !(await retryOperation(
          job,
          () => downloadSource(job, ffmpegPath),
          "downloading",
        ))
      )
        return;
      if (job.cancelRequested || closing) return;
      emit(job, { status: "converting", errorMessage: "" });
      const cover =
        job.metadata.coverPath ||
        fs
          .readdirSync(workspace(job))
          .filter((file) => /^source\.(jpg|jpeg|png|webp)$/.test(file))
          .map((file) => path.join(workspace(job), file))[0] ||
        "";
      if (job.thumbnail && !cover)
        throw new Error(
          "The cover artwork could not be saved. Retry this download.",
        );
      const staged = path.join(workspace(job), "verified.mp3");
      await tagAudio({
        ffmpeg: ffmpegPath,
        input: path.join(workspace(job), "source.mp3"),
        output: staged,
        metadata: job.metadata,
        cover,
        signal: job.abort.signal,
      });
      if (job.cancelRequested || closing) return;
      emit(job, { status: "verifying" });
      job.validation = await validateAudio(
        staged,
        job.metadata,
        Boolean(cover),
        ffmpegPath,
        job.abort.signal,
      );
      if (job.cancelRequested || closing) return;
      job.outputPath = publish(job, staged);
      finish(job, "completed");
    } catch (error) {
      if (!closing && !job.cancelRequested) {
        trace(job, error.message);
        finish(job, "failed", summarizeError(error.message));
      }
    } finally {
      if (job.cancelRequested && !closing && ACTIVE.includes(job.status))
        finish(job, "canceled");
      running--;
      delete job.abort;
      pump();
    }
  };
  const pump = () => {
    if (paused || closing || repaired) return;
    const limit = store.getSettings().concurrency || 2;
    for (const job of jobs.values()) {
      if (running >= limit) break;
      if (job.status !== "queued") continue;
      running++;
      job.status = "preparing";
      const execution = runJob(job);
      executions.add(execution);
      void execution.finally(() => executions.delete(execution));
    }
  };
  const startDownload = async (payload) => {
    const id = videoId(payload.url);
    if (!id) throw new Error("Choose a YouTube video before downloading.");
    const duplicate = [...jobs.values()].find(
      (job) => job.videoId === id && ACTIVE.includes(job.status),
    );
    if (duplicate)
      return { id: duplicate.id, status: duplicate.status, duplicate: true };
    const existing = findExisting(id);
    if (existing && !payload.downloadAgain)
      return { alreadyDownloaded: existing };
    const settings = store.getSettings();
    const job = {
      id: "job-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8),
      videoId: id,
      url: watchUrl(id),
      title:
        payload.metadata?.title || payload.preview?.title || "Preparing video",
      preview: payload.preview || null,
      metadata: payload.metadata
        ? normalizeMetadata(payload.metadata, payload.preview)
        : null,
      outputDirectory: payload.outputDirectory || settings.outputDirectory,
      quality: QUALITY_PRESETS[payload.quality]
        ? payload.quality
        : settings.quality || "high",
      status: "queued",
      progressPercent: 0,
      speed: "",
      eta: "",
      startedAt: new Date().toISOString(),
      completedAt: null,
      outputPath: "",
      errorMessage: "",
      trace: [],
      cancelRequested: false,
      child: null,
    };
    jobs.set(job.id, job);
    emit(job);
    queueMicrotask(pump);
    return { id: job.id, status: "queued" };
  };
  const retryDownload = async (id) => {
    const original =
      jobs.get(id) || store.getHistory().find((job) => job.id === id);
    if (!original) throw new Error("This download is no longer in history.");
    if (ACTIVE.includes(original.status)) {
      if (original.status === "interrupted") {
        emit(original, {
          status: "queued",
          errorMessage: "",
          cancelRequested: false,
        });
        paused = false;
        pump();
      }
      return { id: original.id, status: original.status };
    }
    const duplicate = [...jobs.values()].find(
      (job) =>
        job.id !== id &&
        job.videoId === original.videoId &&
        ACTIVE.includes(job.status),
    );
    if (duplicate)
      return { id: duplicate.id, status: duplicate.status, duplicate: true };
    // Reuse a failed job's private workspace and settings to continue partial files safely.
    const job = {
      ...original,
      status: "queued",
      errorMessage: "",
      completedAt: null,
      cancelRequested: false,
      trace: original.trace || [],
      child: null,
    };
    jobs.set(job.id, job);
    emit(job);
    queueMicrotask(pump);
    return { id: job.id, status: "queued" };
  };
  return {
    warmup: async () => {
      if (closing) return;
      await youtube.ensure();
      if (closing) return;
      await ffmpeg.ensureFfmpegBinary();
    },
    searchVideos: youtube.search,
    fetchPlaylist: youtube.playlist,
    fetchPreview: youtube.fetchPreview,
    getDownloads: () => [...jobs.values()].map(serial),
    getLibrary,
    findExisting,
    getStartupRecovery: () => startupRecovery,
    getQueueState: () => ({ paused }),
    startDownload,
    retryDownload,
    enqueueBatch: async (payloads) => {
      if (!Array.isArray(payloads) || payloads.length > 100)
        throw new Error("Add up to 100 videos at a time.");
      for (const payload of payloads)
        if (!videoId(payload.url))
          throw new Error("One of the links is not a YouTube video.");
      const results = [];
      for (const payload of payloads)
        results.push(await startDownload(payload));
      return results;
    },
    setQueuePaused: (value) => {
      paused = Boolean(value);
      pump();
      return { paused };
    },
    resumeRecovery: () => {
      for (const job of jobs.values())
        if (job.status === "interrupted")
          emit(job, { status: "queued", errorMessage: "" });
      paused = false;
      pump();
      return { paused };
    },
    reorderQueue: (id, direction) => {
      const entries = [...jobs.values()],
        waiting = entries.filter((job) => job.status === "queued"),
        index = waiting.findIndex((job) => job.id === id);
      const target = direction < 0 ? index - 1 : index + 1;
      if (index >= 0 && target >= 0 && target < waiting.length) {
        [waiting[index], waiting[target]] = [waiting[target], waiting[index]];
        let next = 0;
        const reordered = entries.map((job) =>
          job.status === "queued" ? waiting[next++] : job,
        );
        jobs.clear();
        reordered.forEach((job) => jobs.set(job.id, job));
        store.replaceActiveDownloads(
          reordered.filter((job) => ACTIVE.includes(job.status)).map(serial),
        );
      }
      return [...jobs.values()].map(serial);
    },
    cancelDownload: async (id) => {
      const job = jobs.get(id);
      if (!job || !ACTIVE.includes(job.status)) return { ok: false };
      job.cancelRequested = true;
      job.abort?.abort();
      if (job.wakeRetry) {
        clearTimeout(job.timer);
        job.timer = null;
        job.wakeRetry();
      }
      if (job.child) {
        await stopProcessTree(job.child);
      } else if (["queued", "interrupted"].includes(job.status))
        finish(job, "canceled");
      return { ok: true };
    },
    repairTools: async () => {
      if (running || repaired)
        throw new Error(
          "Pause the queue and let current downloads finish before repairing tools.",
        );
      repaired = (async () => {
        const ytDlp = await youtube.repair(),
          binary = await ffmpeg.ensureFfmpegBinary();
        const version = await audio.run(binary, ["-version"], 10000);
        const probe = await audio.run(
          audio.bundledPath(require("ffprobe-static").path),
          ["-version"],
          10000,
        );
        return {
          ytDlp,
          ffmpeg: version.split(/\r?\n/)[0],
          ffprobe: probe.split(/\r?\n/)[0],
          checkedAt: new Date().toISOString(),
          healthy: true,
        };
      })();
      try {
        return await repaired;
      } finally {
        repaired = null;
        pump();
      }
    },
    shutdown: () => {
      closing = true;
      for (const job of jobs.values()) {
        if (!ACTIVE.includes(job.status)) continue;
        emit(job, {
          status: "interrupted",
          errorMessage: "Interrupted when TubeDeck closed.",
        });
        clearTimeout(job.timer);
        job.wakeRetry?.();
        job.abort?.abort();
        if (job.child) void stopProcessTree(job.child);
      }
      return Promise.allSettled([...executions]);
    },
  };
};
module.exports = { createDownloaderService };
