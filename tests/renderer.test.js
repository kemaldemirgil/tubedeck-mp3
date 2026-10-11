const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const createFixture = (overrides = {}) => {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        value: "",
        textContent: "",
        innerHTML: "",
        className: "",
        listeners: {},
        addEventListener(name, callback) {
          this.listeners[name] = callback;
        },
        setAttribute() {},
        querySelector() {
          return null;
        },
      });
    return elements.get(id);
  };
  const subscriptions = {};
  const noop = () => {};
  const context = vm.createContext({
    document: {
      getElementById: element,
      querySelectorAll: () => [],
      addEventListener: noop,
      querySelector: () => null,
    },
    window: {
      addEventListener: noop,
      tubeDeck: {
        getBootstrapState: () => new Promise(() => {}),
        onDownloadUpdate: (callback) =>
          (subscriptions.downloadUpdate = callback),
        onHistoryUpdate: noop,
        onLibraryUpdate: noop,
        onQueueUpdate: noop,
        onSettingsUpdate: noop,
        onUpdateState: noop,
        ...overrides,
      },
    },
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8"),
    context,
  );
  return { element, context, subscriptions };
};
test("a failure arriving before the queue reply keeps its error visible", async () => {
  let reply;
  const { element, context, subscriptions } = createFixture({
    downloadVideo: () => new Promise((resolve) => (reply = resolve)),
  });
  vm.runInContext(
    'state.preview={id:"s_oktKc_wyo",url:"https://youtu.be/s_oktKc_wyo",title:"What I Need"};state.settings={outputDirectory:"Desktop",concurrency:2};',
    context,
  );
  element("metadataTitle").value = "What I Need";
  element("qualitySelect").value = "high";
  const starting = element("downloadButton").listeners.click();
  const error = "YouTube rejected the audio download (HTTP 403).";
  subscriptions.downloadUpdate({
    id: "job-1",
    videoId: "s_oktKc_wyo",
    title: "What I Need",
    status: "failed",
    errorMessage: error,
  });
  assert.equal(element("formMessage").textContent, error);
  reply({ id: "job-1", status: "queued" });
  await starting;
  assert.equal(element("formMessage").textContent, error);
  assert.equal(element("formMessage").className, "form-message danger");
});

test("pagination cannot steal cleanup from a pending search", async () => {
  const replies = [];
  const { element, context } = createFixture({
    searchVideos: () => new Promise((resolve) => replies.push(resolve)),
  });
  vm.runInContext(
    'state.settings={outputDirectory:"Desktop"};state.searchQuery="old search";state.results=[{id:"s_oktKc_wyo",title:"Previous result",uploader:"Artist",thumbnail:"",durationLabel:"4:20"}];renderResults();',
    context,
  );
  element("videoUrl").value = "new search";
  const pendingSearch = element("previewForm").listeners.submit({
    preventDefault() {},
  });
  assert.equal(element("moreResultsButton").disabled, true);
  await element("moreResultsButton").listeners.click();
  assert.equal(replies.length, 1);
  replies[0]([]);
  await pendingSearch;
  assert.equal(vm.runInContext("state.busy", context), false);
  assert.equal(element("previewButton").disabled, false);

  const pendingMore = element("moreResultsButton").listeners.click();
  assert.equal(element("previewButton").disabled, true);
  replies[1]([]);
  await pendingMore;
  assert.equal(element("previewButton").disabled, false);
  assert.equal(element("moreResultsButton").disabled, false);
});
