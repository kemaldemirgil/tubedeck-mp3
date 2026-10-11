const fs = require("fs");
const path = require("path");
const { videoId } = require("./media");
const HISTORY_LIMIT = 40;
const CURRENT_STATE_VERSION = 3;
const readJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};
const writeJsonAtomic = (filePath, value) => {
  fs.writeFileSync(filePath + ".tmp", JSON.stringify(value, null, 2));
  fs.renameSync(filePath + ".tmp", filePath);
};
const normalizeSettings = (settings, defaults) => ({
  ...defaults,
  outputDirectory:
    typeof settings?.outputDirectory === "string" && settings.outputDirectory
      ? settings.outputDirectory
      : defaults.outputDirectory,
  quality: ["high", "balanced", "small"].includes(settings?.quality)
    ? settings.quality
    : "high",
  concurrency: [1, 2, 3].includes(settings?.concurrency)
    ? settings.concurrency
    : 2,
  notifications: settings?.notifications === true,
  windowBounds:
    settings?.windowBounds &&
    ["x", "y", "width", "height"].every((key) =>
      Number.isFinite(settings.windowBounds[key]),
    )
      ? settings.windowBounds
      : null,
});
const migrateState = (raw, defaults) => {
  const source = raw && typeof raw === "object" ? raw : {};
  const history = Array.isArray(source.history)
    ? source.history
        .filter((item) => item && typeof item.id === "string")
        .slice(0, HISTORY_LIMIT)
    : [];
  const library = Array.isArray(source.library)
    ? source.library.filter(
        (item) => item && typeof item.outputPath === "string",
      )
    : [];
  for (const item of history) {
    const id = item.videoId || videoId(item.url);
    if (
      item.status === "completed" &&
      id &&
      item.outputPath &&
      !library.some((entry) => entry.videoId === id)
    )
      library.push({ ...item, videoId: id });
  }
  return {
    version: CURRENT_STATE_VERSION,
    settings: normalizeSettings(source.settings, defaults.settings),
    history,
    library,
    activeDownloads: Array.isArray(source.activeDownloads)
      ? source.activeDownloads.filter(
          (item) =>
            item && typeof item.id === "string" && typeof item.url === "string",
        )
      : [],
  };
};
const createStore = (app, logger) => {
  const directory = app.getPath("userData");
  const statePath = path.join(directory, "state.json");
  fs.mkdirSync(directory, { recursive: true });
  const defaults = {
    settings: {
      outputDirectory: app.getPath("desktop"),
      quality: "high",
      concurrency: 2,
      notifications: false,
      windowBounds: null,
    },
  };
  const state = migrateState(readJson(statePath, defaults), defaults);
  const persist = () => writeJsonAtomic(statePath, state);
  const copy = (value) => structuredClone(value);
  persist();
  return {
    getSettings: () => copy(state.settings),
    getHistory: () => copy(state.history),
    getLibrary: () => copy(state.library),
    getActiveDownloads: () => copy(state.activeDownloads),
    updateSettings: (settings) => {
      state.settings = normalizeSettings(
        { ...state.settings, ...settings },
        defaults.settings,
      );
      persist();
      return copy(state.settings);
    },
    setOutputDirectory: (outputDirectory) => {
      state.settings.outputDirectory = outputDirectory;
      persist();
      return copy(state.settings);
    },
    upsertHistoryItem: (item) => {
      state.history = [
        copy(item),
        ...state.history.filter((entry) => entry.id !== item.id),
      ].slice(0, HISTORY_LIMIT);
      persist();
      logger.info("history.item.upserted", {
        id: item.id,
        status: item.status,
      });
      return item;
    },
    upsertLibraryItem: (item) => {
      state.library = [
        copy(item),
        ...state.library.filter((entry) => entry.videoId !== item.videoId),
      ];
      persist();
      return item;
    },
    upsertActiveDownload: (item) => {
      const index = state.activeDownloads.findIndex(
        (entry) => entry.id === item.id,
      );
      if (index < 0) state.activeDownloads.push(copy(item));
      else state.activeDownloads[index] = copy(item);
      persist();
      return item;
    },
    replaceActiveDownloads: (items) => {
      state.activeDownloads = copy(items);
      persist();
    },
    removeActiveDownload: (id) => {
      state.activeDownloads = state.activeDownloads.filter(
        (entry) => entry.id !== id,
      );
      persist();
    },
    consumeInterruptedDownloads: () => {
      const items = copy(state.activeDownloads);
      state.activeDownloads = [];
      persist();
      return items;
    },
  };
};
module.exports = { createStore };
