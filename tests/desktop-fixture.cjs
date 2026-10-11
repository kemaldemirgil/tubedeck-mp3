const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const childProcess = require("child_process");
const { app } = require("electron");
const { watchUrl } = require("../src/main/media");
app.setPath("userData", process.env.TUBEDECK_USER_DATA);
const assets = path.join(process.env.TUBEDECK_USER_DATA, "fixtures");
fs.mkdirSync(assets, { recursive: true });
const ffmpeg = require("ffmpeg-static");
for (const args of [
  [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    path.join(assets, "tone.mp3"),
  ],
  [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=purple:s=32x32:d=0.1",
    "-frames:v",
    "1",
    path.join(assets, "cover.jpg"),
  ],
]) {
  const result = childProcess.spawnSync(ffmpeg, args, { windowsHide: true });
  if (result.status) throw new Error(result.stderr.toString());
}
const results = [
  {
    id: "s_oktKc_wyo",
    title: "What I Need",
    uploader: "BLIMP - Topic",
    artist: "BLIMP",
    duration: 1,
    durationLabel: "4:20",
  },
  {
    id: "jfKfPfyJRdk",
    title: "Quiet Evening",
    uploader: "Lofi sessions",
    artist: "Lofi sessions",
    duration: 1,
    durationLabel: "3:42",
  },
  {
    id: "dQw4w9WgXcQ",
    title: "Unavailable version",
    uploader: "Test channel",
    duration: 1,
    durationLabel: "2:18",
  },
].map((item) => ({
  ...item,
  url: watchUrl(item.id),
  thumbnail: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
  album: "",
  description: "",
}));
require("../src/main/youtube").createYouTubeService = () => ({
  ensure: async () => "tubedeck-fixture",
  runtimeArgs: [],
  environment: {},
  search: async () => results,
  fetchPreview: async (url) =>
    results.find((item) => item.id === new URL(url).searchParams.get("v")) ||
    results[0],
  playlist: async () => ({
    title: "Fixture playlist",
    results,
    limited: false,
  }),
  repair: async () => "fixture 1.0",
});
const originalSpawn = childProcess.spawn;
childProcess.spawn = (binary, args, options) => {
  if (binary !== "tubedeck-fixture")
    return originalSpawn(binary, args, options);
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const timer = setTimeout(() => {
    if (args.at(-1).includes("dQw4w9WgXcQ")) {
      child.stderr.emit("data", Buffer.from("ERROR: Video unavailable\n"));
      child.emit("close", 1);
      return;
    }
    const output = args[args.indexOf("-o") + 1].replace("%(ext)s", "mp3");
    fs.copyFileSync(path.join(assets, "tone.mp3"), output);
    fs.copyFileSync(
      path.join(assets, "cover.jpg"),
      path.join(path.dirname(output), "source.jpg"),
    );
    child.stdout.emit(
      "data",
      Buffer.from(
        "TD_PROGRESS:50%|1MiB/s|00:01\n[ExtractAudio] Destination: source.mp3\n",
      ),
    );
    child.emit("close", 0);
  }, 100);
  child.kill = () => {
    clearTimeout(timer);
    child.emit("close", 143);
  };
  return child;
};
require("../electron/main");
