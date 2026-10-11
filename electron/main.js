const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  clipboard,
  Notification,
  session,
  screen,
} = require("electron");
const { createLogger } = require("../src/main/logger");
const { createStore } = require("../src/main/store");
const { createDownloaderService } = require("../src/main/downloader");
const { createPlayerServer } = require("../src/main/player-server");
const { videoId, fileName } = require("../src/main/media");
const { createUpdateManager } = require("../src/main/updates");
if (process.env.TUBEDECK_USER_DATA)
  app.setPath("userData", path.resolve(process.env.TUBEDECK_USER_DATA));
app.setAppUserModelId("com.codex.tubedeckmp3");
let mainWindow, store, downloader, player, updates;
const broadcast = (channel, data) => {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send(channel, data);
};
const createMainWindow = () => {
  const saved = store.getSettings().windowBounds;
  const bounds =
    saved &&
    screen
      .getAllDisplays()
      .some(
        ({ workArea }) =>
          saved.x < workArea.x + workArea.width &&
          saved.x + saved.width > workArea.x &&
          saved.y < workArea.y + workArea.height &&
          saved.y + saved.height > workArea.y,
      )
      ? saved
      : { width: 1080, height: 720 };
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: "#0d1015",
    autoHideMenuBar: true,
    title: "TubeDeck MP3",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  mainWindow.on("close", () => {
    store.updateSettings({ windowBounds: mainWindow.getNormalBounds() });
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
};
const registerIpc = (logger) => {
  const handle = (channel, callback) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (
        !mainWindow ||
        event.sender !== mainWindow.webContents ||
        event.senderFrame !== mainWindow.webContents.mainFrame
      )
        throw new Error("This request is not allowed.");
      return callback(...args);
    });
  const payload = (value) => {
    if (!value || typeof value.url !== "string")
      throw new Error("Choose a video first.");
    if (value.metadata?.coverPath) {
      const target = path.resolve(value.metadata.coverPath);
      const root = path.resolve(app.getPath("userData"), "covers");
      if (path.dirname(target) !== root || !fs.existsSync(target))
        throw new Error("Choose the cover image again.");
    }
    if (value.preview && value.preview.id !== videoId(value.url))
      throw new Error("The selected video does not match this link.");
    return value;
  };
  const knownFile = (target) => {
    const item = downloader
      .getLibrary()
      .find((entry) => entry.outputPath === target && entry.available);
    if (!item)
      throw new Error(
        "This downloaded file is missing. Download it again to restore it.",
      );
    return item.outputPath;
  };
  handle("app:get-bootstrap", () => ({
    settings: store.getSettings(),
    history: store.getHistory(),
    downloads: downloader.getDownloads(),
    library: downloader.getLibrary(),
    runtime: {
      startupRecovery: downloader.getStartupRecovery(),
      queue: downloader.getQueueState(),
      player: { base: player.base, token: player.token },
      updates: updates.getState(),
      version: app.getVersion(),
    },
  }));
  handle("video:search", (query, count) =>
    downloader.searchVideos(query, count),
  );
  handle("video:preview", (url) => downloader.fetchPreview(url));
  handle("video:playlist", (url) => downloader.fetchPlaylist(url));
  handle("video:download", (value) => downloader.startDownload(payload(value)));
  handle("video:batch", (values) => {
    if (!Array.isArray(values) || values.length > 100)
      throw new Error("Add up to 100 videos at a time.");
    return downloader.enqueueBatch(values.map(payload));
  });
  handle("video:cancel", (id) => downloader.cancelDownload(id));
  handle("video:retry", (id) => downloader.retryDownload(id));
  handle("video:filename", (metadata) => fileName(metadata));
  handle("queue:pause", (paused) => {
    const state = downloader.setQueuePaused(paused);
    broadcast("queue:updated", state);
    return state;
  });
  handle("queue:continue", () => {
    const state = downloader.resumeRecovery();
    broadcast("queue:updated", state);
    return state;
  });
  handle("queue:reorder", (id, direction) =>
    downloader.reorderQueue(id, direction),
  );
  handle("library:get", () => downloader.getLibrary());
  handle("clipboard:read", () => clipboard.readText());
  handle("clipboard:write", (text) =>
    clipboard.writeText(String(text).slice(0, 12000)),
  );
  handle("settings:update", (settings) => {
    const value = store.updateSettings({
      quality: settings.quality,
      concurrency: Number(settings.concurrency),
      notifications: settings.notifications === true,
    });
    broadcast("settings:updated", value);
    downloader.setQueuePaused(downloader.getQueueState().paused);
    return value;
  });
  handle("settings:choose-output-directory", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose a download folder",
      defaultPath: store.getSettings().outputDirectory,
      properties: ["openDirectory", "createDirectory"],
    });
    if (!result.canceled) {
      store.setOutputDirectory(result.filePaths[0]);
      broadcast("settings:updated", store.getSettings());
    }
    return store.getSettings();
  });
  handle("settings:choose-cover", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose cover artwork",
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }],
      properties: ["openFile"],
    });
    if (result.canceled) return null;
    const source = result.filePaths[0],
      extension = path.extname(source).toLowerCase();
    if (
      ![".jpg", ".jpeg", ".png", ".webp"].includes(extension) ||
      fs.statSync(source).size > 15 * 1024 * 1024
    )
      throw new Error("Choose a JPG, PNG, or WebP image smaller than 15 MB.");
    const name = crypto.randomUUID() + extension;
    const target = path.join(app.getPath("userData"), "covers", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    return {
      path: target,
      url:
        player.base +
        "/cover?name=" +
        encodeURIComponent(name) +
        "&token=" +
        player.token,
    };
  });
  handle("shell:open-output", async () => {
    const error = await shell.openPath(store.getSettings().outputDirectory);
    if (error) throw new Error(error);
  });
  handle("shell:open-path", async (target) => {
    const error = await shell.openPath(knownFile(target));
    if (error) throw new Error(error);
  });
  handle("shell:show-item", (target) =>
    shell.showItemInFolder(knownFile(target)),
  );
  handle("shell:open-youtube", (url) => {
    const id = videoId(url);
    if (!id) throw new Error("Choose a video.");
    return shell.openExternal("https://www.youtube.com/watch?v=" + id);
  });
  handle("shell:open-logs-directory", () =>
    shell.openPath(logger.getLogDirectory()),
  );
  handle("tools:repair", () => downloader.repairTools());
  handle("updates:check", () => updates.check());
  handle("updates:install", () => updates.install());
};
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      nativeTheme.themeSource = "dark";
      const logger = createLogger(app);
      store = createStore(app, logger);
      downloader = createDownloaderService({
        app,
        logger,
        store,
        onDownloadUpdate: (download) => {
          broadcast("downloads:updated", download);
          broadcast("queue:updated", downloader.getQueueState());
          if (
            download.status === "completed" &&
            store.getSettings().notifications &&
            Notification.isSupported()
          ) {
            const notice = new Notification({
              title: "MP3 ready",
              body: download.title,
            });
            notice.on("click", () => mainWindow?.focus());
            notice.show();
          }
        },
        onHistoryUpdate: (item) => broadcast("history:updated", item),
        onLibraryUpdate: (library) => broadcast("library:updated", library),
        onLogEntry: (entry) => broadcast("logs:entry", entry),
      });
      player = await createPlayerServer({
        rendererDirectory: path.join(__dirname, "../renderer"),
        getLibrary: downloader.getLibrary,
        coversDirectory: path.join(app.getPath("userData"), "covers"),
      });
      // Identify this installed desktop app on embed requests; remote frames never receive the preload bridge.
      session.defaultSession.webRequest.onBeforeSendHeaders(
        { urls: ["https://www.youtube.com/embed/*"] },
        (details, callback) =>
          callback({
            requestHeaders: {
              ...details.requestHeaders,
              Referer: "https://com.codex.tubedeckmp3/",
            },
          }),
      );
      updates = createUpdateManager({
        app,
        onUpdate: (state) => broadcast("updates:updated", state),
      });
      registerIpc(logger);
      createMainWindow();
      downloader
        .warmup()
        .catch((error) =>
          logger.warn("downloader.warmup.failed", { message: error.message }),
        );
      app.on("activate", () => {
        if (!mainWindow) createMainWindow();
      });
    })
    .catch((error) => {
      process.stderr.write("TubeDeck startup: " + error.stack + "\n");
      dialog.showErrorBox("TubeDeck could not start", error.message);
      app.quit();
    });
}
let quitReady = false,
  shutdownWait;
app.on("before-quit", (event) => {
  if (quitReady || !downloader) return;
  event.preventDefault();
  shutdownWait ||= downloader.shutdown().finally(() => {
    quitReady = true;
    player?.close();
    app.quit();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
