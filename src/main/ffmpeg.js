const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { createGunzip } = require("zlib");
const ffmpegStatic = require("ffmpeg-static");
const ffmpegPackage = require("ffmpeg-static/package.json");

const ffmpegMetadata = ffmpegPackage[ffmpegPackage.name];
const releaseTag = ffmpegMetadata["binary-release-tag"];
const executableBaseName = ffmpegMetadata["executable-base-name"];
const binariesBaseUrl = "https://github.com/eugeneware/ffmpeg-static/releases/download";

const getRuntimeFfmpegPath = (binDirectory) =>
  path.join(binDirectory, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

const normalizeBundledPath = (candidatePath) => {
  if (!candidatePath) {
    return "";
  }

  return candidatePath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
};

const checkBinary = async (binaryPath) => {
  if (!binaryPath || !fs.existsSync(binaryPath)) {
    return false;
  }

  return new Promise((resolve) => {
    execFile(binaryPath, ["-version"], { windowsHide: true }, (error) => {
      resolve(!error);
    });
  });
};

const downloadRuntimeBinary = async ({ binDirectory, logger, onLogEntry }) => {
  const targetPath = getRuntimeFfmpegPath(binDirectory);
  const downloadUrl = `${binariesBaseUrl}/${releaseTag}/${executableBaseName}-${process.platform}-${process.arch}.gz`;
  const tempPath = `${targetPath}.download`;

  fs.mkdirSync(binDirectory, { recursive: true });

  const startedEntry = logger.info("ffmpeg.download.started", {
    targetPath,
    downloadUrl
  });
  onLogEntry?.(startedEntry);

  const response = await fetch(downloadUrl, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Unable to download ffmpeg (${response.status} ${response.statusText}).`);
  }

  try {
    // Download to a temp file first so a failed download never masquerades as a valid binary.
    await pipeline(
      Readable.fromWeb(response.body),
      createGunzip(),
      fs.createWriteStream(tempPath)
    );

    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
    throw error;
  }

  if (process.platform !== "win32") {
    fs.chmodSync(targetPath, 0o755);
  }

  const works = await checkBinary(targetPath);
  if (!works) {
    throw new Error("Downloaded ffmpeg binary failed validation.");
  }

  const completedEntry = logger.info("ffmpeg.download.completed", {
    targetPath
  });
  onLogEntry?.(completedEntry);

  return targetPath;
};

const createFfmpegManager = ({ binDirectory, logger, onLogEntry }) => {
  let cachedPath = "";

  const ensureFfmpegBinary = async () => {
    // Resolution order matters: prefer the packaged binary, then a previously downloaded runtime copy.
    if (cachedPath && (await checkBinary(cachedPath))) {
      return cachedPath;
    }

    const bundledPath = normalizeBundledPath(ffmpegStatic);
    if (await checkBinary(bundledPath)) {
      cachedPath = bundledPath;
      return cachedPath;
    }

    const runtimePath = getRuntimeFfmpegPath(binDirectory);
    if (await checkBinary(runtimePath)) {
      cachedPath = runtimePath;
      return cachedPath;
    }

    if (process.platform === "win32") {
      cachedPath = await downloadRuntimeBinary({ binDirectory, logger, onLogEntry });
      return cachedPath;
    }

    throw new Error("ffmpeg is not available on this machine.");
  };

  return {
    ensureFfmpegBinary
  };
};

module.exports = {
  createFfmpegManager
};
