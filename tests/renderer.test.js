const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
test("a failure arriving before the queue reply keeps its error visible", async () => {
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
  let downloadUpdate, reply;
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
        downloadVideo: () => new Promise((resolve) => (reply = resolve)),
        onDownloadUpdate: (callback) => (downloadUpdate = callback),
        onHistoryUpdate: noop,
        onLibraryUpdate: noop,
        onQueueUpdate: noop,
        onSettingsUpdate: noop,
        onUpdateState: noop,
      },
    },
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8"),
    context,
  );
  vm.runInContext(
    'state.preview={id:"s_oktKc_wyo",url:"https://youtu.be/s_oktKc_wyo",title:"What I Need"};state.settings={outputDirectory:"Desktop",concurrency:2};',
    context,
  );
  element("metadataTitle").value = "What I Need";
  element("qualitySelect").value = "high";
  const starting = element("downloadButton").listeners.click();
  const error = "YouTube rejected the audio download (HTTP 403).";
  downloadUpdate({
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
