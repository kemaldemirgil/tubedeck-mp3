const fs = require("fs");
const path = require("path");
const { runProcess } = require("./process");
const ffprobeStatic = require("ffprobe-static");
const bundledPath = (value) =>
  value.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`,
  );
const run = (binary, args, timeout = 120000, signal) =>
  runProcess(binary, args, { timeout, signal });
const inspect = async (file, signal) => {
  if (
    !file ||
    !fs.existsSync(file) ||
    !fs.statSync(file).isFile() ||
    fs.statSync(file).size < 128
  )
    throw new Error("The finished MP3 file is missing or empty.");
  const data = JSON.parse(
    await run(
      bundledPath(ffprobeStatic.path),
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
      120000,
      signal,
    ),
  );
  if (
    !data.streams?.some(
      (stream) => stream.codec_type === "audio" && stream.codec_name === "mp3",
    ) ||
    !(Number(data.format?.duration) > 0)
  )
    throw new Error("The downloaded file does not contain readable MP3 audio.");
  return data;
};
const validateAudio = async (file, metadata, expectArtwork, ffmpeg, signal) => {
  const data = await inspect(file, signal);
  const tags = Object.fromEntries(
    Object.entries(data.format?.tags || {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  for (const key of ["title", "artist", "album"])
    if (metadata[key] && tags[key] !== metadata[key])
      throw new Error(`The MP3 ${key} tag could not be verified.`);
  if (
    expectArtwork &&
    !data.streams.some((stream) => stream.disposition?.attached_pic === 1)
  )
    throw new Error("The MP3 cover artwork could not be verified.");
  await run(
    ffmpeg,
    ["-v", "error", "-xerror", "-i", file, "-map", "0:a:0", "-f", "null", "-"],
    Math.max(120000, Number(data.format.duration) * 1000),
    signal,
  );
  return {
    durationSeconds: Number(data.format.duration),
    size: fs.statSync(file).size,
    artwork: data.streams.some(
      (stream) => stream.disposition?.attached_pic === 1,
    ),
    tags,
  };
};
const tagAudio = async ({ ffmpeg, input, output, metadata, cover, signal }) => {
  const args = ["-y", "-v", "error", "-i", input];
  if (cover) args.push("-i", cover);
  args.push("-map", "0:a:0");
  if (cover)
    args.push(
      "-map",
      "1:v:0",
      "-c:v",
      "mjpeg",
      "-disposition:v:0",
      "attached_pic",
    );
  args.push("-c:a", "copy", "-id3v2_version", "3");
  for (const key of ["title", "artist", "album"])
    args.push("-metadata", `${key}=${metadata[key]}`);
  if (cover)
    args.push(
      "-metadata:s:v",
      "title=Album cover",
      "-metadata:s:v",
      "comment=Cover (front)",
    );
  args.push(output);
  await run(ffmpeg, args, 120000, signal);
};
module.exports = { validateAudio, tagAudio, inspect, run, bundledPath };
