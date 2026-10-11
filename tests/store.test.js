const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createStore } = require("../src/main/store");
const setup = (t, oldState) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tubedeck-store-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  if (oldState)
    fs.writeFileSync(
      path.join(directory, "state.json"),
      JSON.stringify(oldState),
    );
  const app = { getPath: () => directory },
    logger = { info() {} };
  return { directory, open: () => createStore(app, logger) };
};
test("migration preserves output settings, completed files, and interrupted jobs", (t) => {
  const fixture = setup(t, {
    version: 2,
    settings: { outputDirectory: "C:\\Music" },
    history: [
      {
        id: "old",
        url: "https://youtu.be/s_oktKc_wyo",
        status: "completed",
        outputPath: "C:\\Music\\song.mp3",
      },
    ],
    activeDownloads: [
      { id: "job-1", url: "https://youtu.be/s_oktKc_wyo", status: "running" },
    ],
  });
  const store = fixture.open();
  assert.equal(store.getSettings().outputDirectory, "C:\\Music");
  assert.equal(store.getLibrary()[0].videoId, "s_oktKc_wyo");
  assert.equal(store.getActiveDownloads()[0].id, "job-1");
  assert.equal(fixture.open().getLibrary().length, 1);
});
test("the saved library survives recent history eviction and queue reordering survives restart", (t) => {
  const fixture = setup(t),
    store = fixture.open();
  store.upsertLibraryItem({
    videoId: "s_oktKc_wyo",
    outputPath: "song.mp3",
    title: "Song",
  });
  for (let i = 0; i < 45; i++)
    store.upsertHistoryItem({ id: "history-" + i, status: "failed" });
  store.replaceActiveDownloads([
    { id: "second", url: "https://youtu.be/s_oktKc_wyo" },
    { id: "first", url: "https://youtu.be/jfKfPfyJRdk" },
  ]);
  const reopened = fixture.open();
  assert.equal(reopened.getHistory().length, 40);
  assert.equal(reopened.getLibrary()[0].title, "Song");
  assert.deepEqual(
    reopened.getActiveDownloads().map((item) => item.id),
    ["second", "first"],
  );
});
test("invalid persisted settings normalize to usable defaults", (t) => {
  const fixture = setup(t, {
    settings: {
      quality: "invalid",
      concurrency: -50,
      windowBounds: { x: "wrong" },
    },
    history: [null],
    activeDownloads: [null],
  });
  const store = fixture.open();
  assert.equal(store.getSettings().quality, "high");
  assert.equal(store.getSettings().concurrency, 2);
  assert.equal(store.getSettings().windowBounds, null);
});
