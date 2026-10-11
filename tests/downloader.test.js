const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { test } = require("node:test");

const setup = (t, { updateError = null } = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tubedeck-test-"));
  fs.mkdirSync(path.join(directory, "bin"));
  fs.writeFileSync(
    path.join(
      directory,
      "bin",
      process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
    ),
    "fixture",
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const calls = [];
  const events = [];
  let finishUpdate;
  t.mock.method(childProcess, "execFile", (binary, args, options, callback) => {
    calls.push({ binary, args, options });
    if (args.includes("--update")) {
      finishUpdate = () =>
        callback(updateError, "Updated yt-dlp", updateError?.message || "");
    } else if (args.includes("--dump-single-json")) {
      callback(
        null,
        JSON.stringify({
          id: "s_oktKc_wyo",
          title: "What I Need",
          duration: 260,
        }),
        "",
      );
    } else {
      callback(null, "ffmpeg version fixture", "");
    }
  });
  t.mock.method(childProcess, "spawn", (binary, args, options) => {
    calls.push({ binary, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
  });

  // Reload the service boundaries after installing process mocks.
  delete require.cache[require.resolve("../src/main/downloader")];
  delete require.cache[require.resolve("../src/main/ffmpeg")];
  delete require.cache[require.resolve("../src/main/youtube")];
  delete require.cache[require.resolve("../src/main/audio")];
  delete require.cache[require.resolve("../src/main/process")];
  const { createDownloaderService } = require("../src/main/downloader");
  const service = createDownloaderService({
    app: { getPath: () => directory },
    logger: Object.fromEntries(
      ["info", "warn", "error"].map((level) => [
        level,
        (event, metadata) => {
          events.push({ level, event, metadata });
          return { level, event, metadata };
        },
      ]),
    ),
    store: {
      consumeInterruptedDownloads: () => [],
      getSettings: () => ({ outputDirectory: directory }),
      upsertActiveDownload: () => {},
      removeActiveDownload: () => {},
      upsertHistoryItem: () => {},
    },
    onDownloadUpdate: () => {},
    onHistoryUpdate: () => {},
    onLogEntry: () => {},
  });
  return {
    service,
    directory,
    calls,
    events,
    finishUpdate: () => finishUpdate(),
  };
};

test("preview and download wait for one shared update of the cached downloader", async (t) => {
  const fixture = setup(t);
  const warming = fixture.service.warmup();
  const previewing = fixture.service.fetchPreview(
    "https://youtu.be/s_oktKc_wyo",
  );
  assert.equal(
    fixture.calls.filter(({ args }) => args.includes("--update")).length,
    1,
  );
  assert.equal(
    fixture.calls.some(({ args }) => args.includes("--dump-single-json")),
    false,
  );
  fixture.finishUpdate();
  const [, preview] = await Promise.all([warming, previewing]);
  await fixture.service.startDownload({ url: preview.url, preview });
  await new Promise(setImmediate);
  assert.equal(
    fixture.calls.filter(({ args }) => args.includes("--update")).length,
    1,
  );
  for (const { args, options } of fixture.calls.filter(
    ({ args }) =>
      args.includes("--dump-single-json") || args.includes("--extract-audio"),
  )) {
    assert.equal(
      args[args.indexOf("--js-runtimes") + 1],
      `node:${process.execPath}`,
    );
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
  }
  const downloadArgs = fixture.calls.find(({ args }) =>
    args.includes("--extract-audio"),
  ).args;
  assert.ok(downloadArgs.includes("--embed-thumbnail"));
  assert.ok(downloadArgs.includes("--embed-metadata"));
  assert.ok(downloadArgs.some((arg) => arg.endsWith("source.%(ext)s")));
});

test("an unavailable update service preserves the installed downloader", async (t) => {
  const fixture = setup(t, { updateError: new Error("GitHub is offline") });
  const previewing = fixture.service.fetchPreview(
    "https://youtu.be/s_oktKc_wyo",
  );
  assert.equal(
    fixture.calls.filter(({ args }) => args.includes("--update")).length,
    1,
  );
  fixture.finishUpdate();
  const preview = await previewing;
  assert.equal(preview.title, "What I Need");
  assert.ok(
    fixture.events.some(
      ({ level, event }) =>
        level === "warn" && event === "downloader.binary.update.failed",
    ),
  );
});

test("shutdown releases a job waiting for shared YouTube setup without starting more tools", async (t) => {
  const fixture = setup(t);
  const warming = fixture.service.warmup();
  await fixture.service.startDownload({ url: "https://youtu.be/s_oktKc_wyo" });
  await new Promise(setImmediate);
  await fixture.service.shutdown();
  const count = fixture.calls.length;
  fixture.finishUpdate();
  await warming;
  await new Promise(setImmediate);
  assert.equal(fixture.calls.length, count);
  assert.equal(
    fixture.calls.some(({ args }) => args.includes("--dump-single-json")),
    false,
  );
  assert.equal(
    fixture.calls.some(({ args }) => args.includes("--extract-audio")),
    false,
  );
});
