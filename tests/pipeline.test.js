const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { test, before, after } = require("node:test");
const { createStore } = require("../src/main/store");
const { createDownloaderService } = require("../src/main/downloader");
const { run, inspect } = require("../src/main/audio");
const ffmpegPath = require("ffmpeg-static");
let assets;
before(async () => {
  assets = fs.mkdtempSync(path.join(os.tmpdir(), "tubedeck-assets-"));
  await run(ffmpegPath, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=0.3",
    "-q:a",
    "2",
    path.join(assets, "tone.mp3"),
  ]);
  await run(ffmpegPath, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=purple:s=32x32:d=0.1",
    "-frames:v",
    "1",
    path.join(assets, "cover.jpg"),
  ]);
});
after(() => fs.rmSync(assets, { recursive: true, force: true }));
const waitFor = async (condition) => {
  const deadline = Date.now() + 8000;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for job state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const setup = (t, options = {}) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "tubedeck-pipeline-"),
  );
  const app = { getPath: () => directory },
    logger = { info() {}, warn() {}, error() {} };
  const store = createStore(app, logger),
    calls = [],
    children = [];
  const preview = (id) => ({
    id,
    url: "https://www.youtube.com/watch?v=" + id,
    title: "Same title",
    uploader: "Artist",
    artist: "Artist",
    duration: 0.3,
    durationLabel: "0:01",
    thumbnail: "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg",
  });
  const youtube = {
    ensure: async () => "fixture",
    runtimeArgs: [],
    environment: {},
    fetchPreview: async (url) => preview(new URL(url).searchParams.get("v")),
  };
  const spawnProcess = (_binary, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit("close", 143);
    child.complete = (error = "", missing = false) => {
      if (!error && !missing) {
        const output = args[args.indexOf("-o") + 1].replace("%(ext)s", "mp3");
        fs.copyFileSync(path.join(assets, "tone.mp3"), output);
        fs.copyFileSync(
          path.join(assets, "cover.jpg"),
          path.join(path.dirname(output), "source.jpg"),
        );
      }
      if (error) child.stderr.emit("data", Buffer.from(error));
      child.stdout.emit(
        "data",
        Buffer.from("TD_PROGRESS: 100%|1MiB/s|00:00\n"),
      );
      child.emit("close", error ? 1 : 0);
    };
    children.push(child);
    if (options.automatic) setImmediate(() => child.complete());
    return child;
  };
  const service = createDownloaderService({
    app,
    logger,
    store,
    youtube,
    ffmpeg: { ensureFfmpegBinary: async () => ffmpegPath },
    spawnProcess,
    retryDelays: [10, 20],
    ...options.dependencies,
  });
  t.after(async () => {
    await service.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { app, logger, directory, store, service, calls, children, preview };
};
test("completed files contain verified audio, editable tags and artwork; same titles cannot overwrite", async (t) => {
  const fixture = setup(t, { automatic: true });
  const metadata = {
    title: "My Song",
    artist: "Correct artist",
    album: "Correct album",
  };
  const first = await fixture.service.startDownload({
    url: "https://youtu.be/s_oktKc_wyo",
    metadata,
  });
  const second = await fixture.service.startDownload({
    url: "https://youtu.be/jfKfPfyJRdk",
    metadata,
    quality: "small",
  });
  await waitFor(
    () =>
      fixture.store.getHistory().filter((item) => item.status === "completed")
        .length === 2,
  );
  const files = fixture.store.getHistory();
  assert.deepEqual(
    new Set(files.map((item) => path.basename(item.outputPath))),
    new Set(["My Song.mp3", "My Song (2).mp3"]),
  );
  for (const item of files) {
    const data = await inspect(item.outputPath);
    assert.equal(data.format.tags.artist, "Correct artist");
    assert.equal(data.format.tags.album, "Correct album");
    assert.ok(
      data.streams.some((stream) => stream.disposition?.attached_pic === 1),
    );
  }
  assert.notEqual(
    fixture.calls[0][fixture.calls[0].indexOf("-o") + 1],
    fixture.calls[1][fixture.calls[1].indexOf("-o") + 1],
  );
  assert.ok(fixture.calls.some((args) => args.includes("128K")));
  const duplicate = await fixture.service.startDownload({
    url: "https://www.youtube.com/watch?v=s_oktKc_wyo&list=example",
  });
  assert.equal(duplicate.alreadyDownloaded.videoId, "s_oktKc_wyo");
  fs.unlinkSync(fixture.service.findExisting("s_oktKc_wyo").outputPath);
  assert.equal(fixture.service.findExisting("s_oktKc_wyo"), undefined);
  assert.equal(
    fixture.service.getLibrary().find((item) => item.videoId === "s_oktKc_wyo")
      .available,
    false,
  );
});
test("an exit code of zero without an MP3 never reports completion", async (t) => {
  const fixture = setup(t);
  const { id } = await fixture.service.startDownload({
    url: "https://youtu.be/s_oktKc_wyo",
  });
  await waitFor(() => fixture.children.length === 1);
  fixture.children[0].complete("", true);
  await waitFor(() => fixture.store.getHistory().length);
  assert.equal(fixture.store.getHistory()[0].status, "failed");
  assert.equal(fixture.store.getLibrary().length, 0);
});
test("queue limits concurrency, deduplicates videos, and restores interrupted settings after restart", async (t) => {
  const fixture = setup(t);
  fixture.store.updateSettings({ concurrency: 1 });
  const one = await fixture.service.startDownload({
    url: "https://youtu.be/s_oktKc_wyo",
    quality: "small",
    metadata: { title: "Edited title" },
  });
  await waitFor(() => fixture.children.length === 1);
  const two = await fixture.service.startDownload({
    url: "https://youtu.be/jfKfPfyJRdk",
  });
  const duplicate = await fixture.service.startDownload({
    url: "https://www.youtube.com/watch?v=s_oktKc_wyo",
  });
  assert.equal(duplicate.id, one.id);
  assert.equal(fixture.children.length, 1);
  await fixture.service.shutdown();
  const reopened = createDownloaderService({
    app: fixture.app,
    logger: fixture.logger,
    store: fixture.store,
    youtube: {},
    ffmpeg: {},
  });
  assert.equal(reopened.getQueueState().paused, true);
  assert.equal(
    reopened.getDownloads().find((job) => job.id === one.id).quality,
    "small",
  );
  assert.equal(
    reopened.getDownloads().find((job) => job.id === one.id).metadata.title,
    "Edited title",
  );
  assert.equal(
    reopened.getDownloads().find((job) => job.id === two.id).status,
    "interrupted",
  );
  await reopened.shutdown();
});
test("transient failures retry, while rate limiting pauses the queue", async (t) => {
  const fixture = setup(t);
  await fixture.service.startDownload({ url: "https://youtu.be/s_oktKc_wyo" });
  await waitFor(() => fixture.children.length === 1);
  fixture.children[0].complete("ERROR: Connection timed out");
  await waitFor(() => fixture.children.length === 2);
  fixture.children[1].complete("ERROR: HTTP Error 429: Too Many Requests");
  await waitFor(() => fixture.service.getQueueState().paused);
  assert.equal(fixture.service.getDownloads()[0].status, "interrupted");
  assert.equal(fixture.store.getLibrary().length, 0);
});
test("pending jobs can be reordered and canceled without launching a downloader", async (t) => {
  const fixture = setup(t);
  fixture.service.setQueuePaused(true);
  const one = await fixture.service.startDownload({
    url: "https://youtu.be/s_oktKc_wyo",
  });
  const two = await fixture.service.startDownload({
    url: "https://youtu.be/jfKfPfyJRdk",
  });
  const three = await fixture.service.startDownload({
    url: "https://youtu.be/jNQXAC9IVRw",
  });
  await fixture.service.cancelDownload(two.id);
  fixture.service.reorderQueue(three.id, -1);
  assert.deepEqual(
    fixture.store.getActiveDownloads().map((job) => job.id),
    [three.id, one.id],
  );
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.store.getHistory()[0].status, "canceled");
});

test("preparation retries network failures and pauses before starting another job on rate limits", async (t) => {
  let attempts = 0;
  const fixture = setup(t, {
    dependencies: {
      youtube: {
        fetchPreview: async () => {
          attempts++;
          if (attempts === 1) throw new Error("Connection timed out");
          throw new Error("HTTP Error 429: Too Many Requests");
        },
      },
    },
  });
  fixture.store.updateSettings({ concurrency: 1 });
  await fixture.service.startDownload({ url: "https://youtu.be/s_oktKc_wyo" });
  await fixture.service.startDownload({ url: "https://youtu.be/jfKfPfyJRdk" });
  await waitFor(() => fixture.service.getQueueState().paused);
  assert.equal(attempts, 2);
  assert.deepEqual(
    fixture.service.getDownloads().map((job) => job.status),
    ["interrupted", "queued"],
  );
  assert.equal(fixture.store.getHistory().length, 0);
  assert.equal(fixture.children.length, 0);
});

test("an inactivity timeout keeps its workspace and concurrency slot until the child closes", async (t) => {
  const fixture = setup(t, { dependencies: { inactivityTimeout: 30 } });
  fixture.store.updateSettings({ concurrency: 1 });
  await fixture.service.startDownload({ url: "https://youtu.be/s_oktKc_wyo" });
  await waitFor(() => fixture.children.length === 1);
  const first = fixture.children[0];
  let stopped = false;
  first.kill = () => {
    stopped = true;
  };
  await fixture.service.startDownload({ url: "https://youtu.be/jfKfPfyJRdk" });
  await waitFor(() => stopped);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fixture.children.length, 1);
  assert.equal(fixture.service.getDownloads()[0].status, "downloading");
  first.emit("close", 143);
  await waitFor(() => fixture.children.length === 2);
  await fixture.service.cancelDownload(fixture.service.getDownloads()[0].id);
  await waitFor(() => fixture.children.length === 3);
  assert.equal(fixture.service.getDownloads()[1].status, "downloading");
});

test("cancel and shutdown stop audio conversion before releasing jobs or returning", async (t) => {
  let conversions = 0;
  const fixture = setup(t, {
    automatic: true,
    dependencies: {
      tagAudio: async ({ signal }) => {
        conversions++;
        await run(
          process.execPath,
          ["-e", "setInterval(()=>{},1000)"],
          5000,
          signal,
        );
      },
    },
  });
  fixture.store.updateSettings({ concurrency: 1 });
  const first = await fixture.service.startDownload({
    url: "https://youtu.be/s_oktKc_wyo",
  });
  const second = await fixture.service.startDownload({
    url: "https://youtu.be/jfKfPfyJRdk",
  });
  await waitFor(() => conversions === 1);
  await fixture.service.cancelDownload(first.id);
  await waitFor(() => conversions === 2);
  assert.equal(fixture.store.getHistory()[0].status, "canceled");
  await fixture.service.shutdown();
  assert.equal(
    fixture.store.getActiveDownloads().find((job) => job.id === second.id)
      .status,
    "interrupted",
  );
  assert.equal(fixture.store.getLibrary().length, 0);
});

test("shutdown does not wait for shared tool setup or start a job after it resolves", async (t) => {
  let ready;
  const fixture = setup(t, {
    dependencies: {
      ffmpeg: {
        ensureFfmpegBinary: () =>
          new Promise((resolve) => {
            ready = resolve;
          }),
      },
    },
  });
  await fixture.service.startDownload({ url: "https://youtu.be/s_oktKc_wyo" });
  await waitFor(() => ready);
  await fixture.service.shutdown();
  ready(ffmpegPath);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.store.getActiveDownloads()[0].status, "interrupted");
});
