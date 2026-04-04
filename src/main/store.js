const fs = require("fs");
const path = require("path");

const HISTORY_LIMIT = 40;
const CURRENT_STATE_VERSION = 2;

const readJson = (filePath, fallback) => {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return fallback;
  }
};

const writeJsonAtomic = (filePath, value) => {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  fs.renameSync(tempPath, filePath);
};

const normalizeSettings = (settings, defaultSettings) => {
  if (!settings || typeof settings !== "object") {
    return { ...defaultSettings };
  }

  return {
    outputDirectory: settings.outputDirectory || defaultSettings.outputDirectory
  };
};

const normalizeHistory = (history) => (Array.isArray(history) ? history.slice(0, HISTORY_LIMIT) : []);

const normalizeActiveDownloads = (activeDownloads) => (Array.isArray(activeDownloads) ? activeDownloads.slice() : []);

const migrateState = (rawState, defaultState) => {
  // Keep migrations normalization-based until a future schema change needs branching logic.
  const source = rawState && typeof rawState === "object" ? rawState : {};
  const migrated = {
    version: CURRENT_STATE_VERSION,
    settings: normalizeSettings(source.settings, defaultState.settings),
    history: normalizeHistory(source.history),
    activeDownloads: normalizeActiveDownloads(source.activeDownloads)
  };

  return migrated;
};

const createStore = (app, logger) => {
  const dataDirectory = app.getPath("userData");
  const statePath = path.join(dataDirectory, "state.json");

  fs.mkdirSync(dataDirectory, { recursive: true });

  const defaultState = {
    version: CURRENT_STATE_VERSION,
    settings: {
      outputDirectory: app.getPath("desktop")
    },
    history: [],
    activeDownloads: []
  };

  const rawState = readJson(statePath, defaultState);
  const state = migrateState(rawState, defaultState);

  const persist = () => {
    // Atomic rename keeps a partial write from corrupting the only copy of app state.
    state.version = CURRENT_STATE_VERSION;
    writeJsonAtomic(statePath, state);
  };

  const replaceActiveDownload = (download) => {
    const existingIndex = state.activeDownloads.findIndex((item) => item.id === download.id);
    if (existingIndex >= 0) {
      state.activeDownloads.splice(existingIndex, 1, download);
      return;
    }

    state.activeDownloads.unshift(download);
  };

  persist();

  return {
    getSettings: () => ({ ...state.settings }),
    getHistory: () => state.history.slice(),
    getActiveDownloads: () => state.activeDownloads.slice(),
    setOutputDirectory: (outputDirectory) => {
      state.settings.outputDirectory = outputDirectory;
      persist();

      return { ...state.settings };
    },
    upsertHistoryItem: (historyItem) => {
      const existingIndex = state.history.findIndex((item) => item.id === historyItem.id);
      if (existingIndex >= 0) {
        state.history.splice(existingIndex, 1);
      }

      state.history.unshift(historyItem);
      state.history = state.history.slice(0, HISTORY_LIMIT);
      persist();

      logger.info("history.item.upserted", {
        id: historyItem.id,
        status: historyItem.status,
        title: historyItem.title
      });

      return historyItem;
    },
    upsertActiveDownload: (download) => {
      replaceActiveDownload(download);
      persist();

      return download;
    },
    removeActiveDownload: (downloadId) => {
      const existingIndex = state.activeDownloads.findIndex((item) => item.id === downloadId);
      if (existingIndex < 0) {
        return false;
      }

      state.activeDownloads.splice(existingIndex, 1);
      persist();
      return true;
    },
    consumeInterruptedDownloads: () => {
      // Startup recovery reads and clears this list once so interrupted jobs are not replayed forever.
      const interrupted = state.activeDownloads.slice();
      if (!interrupted.length) {
        return [];
      }

      state.activeDownloads = [];
      persist();

      logger.warn("downloads.interrupted.recovered", {
        count: interrupted.length
      });

      return interrupted;
    }
  };
};

module.exports = {
  createStore
};
