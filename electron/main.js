const path = require("path");
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } = require("electron");
const { createLogger } = require("../src/main/logger");
const { createStore } = require("../src/main/store");
const { createDownloaderService } = require("../src/main/downloader");

let mainWindow = null;

const createMainWindow = () => {
  // Keep the desktop window compact by default; the UI is designed around this footprint.
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: "#0d1015",
    autoHideMenuBar: true,
    title: "TubeDeck MP3",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
};

const broadcast = (channel, payload) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(channel, payload);
};

const registerIpc = ({ store, logger, downloader }) => {
  // Bootstrap returns everything the renderer needs to paint without extra round-trips.
  ipcMain.handle("app:get-bootstrap", async () => ({
    settings: store.getSettings(),
    history: store.getHistory(),
    downloads: downloader.getDownloads(),
    logs: logger.readRecent(),
    runtime: {
      startupRecovery: downloader.getStartupRecovery()
    }
  }));

  ipcMain.handle("video:preview", async (_event, url) => downloader.fetchPreview(url));

  ipcMain.handle("video:download", async (_event, payload) => downloader.startDownload(payload));

  ipcMain.handle("video:cancel", async (_event, downloadId) => downloader.cancelDownload(downloadId));

  ipcMain.handle("settings:choose-output-directory", async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose a download folder",
      defaultPath: store.getSettings().outputDirectory,
      properties: ["openDirectory", "createDirectory"]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return store.getSettings();
    }

    const nextSettings = store.setOutputDirectory(result.filePaths[0]);
    logger.info("settings.outputDirectory.updated", { outputDirectory: nextSettings.outputDirectory });
    broadcast("settings:updated", nextSettings);

    return nextSettings;
  });

  ipcMain.handle("shell:open-path", async (_event, targetPath) => {
    if (!targetPath) {
      return;
    }

    await shell.openPath(targetPath);
  });

  ipcMain.handle("shell:show-item", async (_event, targetPath) => {
    if (!targetPath) {
      return;
    }

    shell.showItemInFolder(targetPath);
  });

  ipcMain.handle("shell:open-logs-directory", async () => {
    await shell.openPath(logger.getLogDirectory());
  });
};

app.whenReady().then(async () => {
  nativeTheme.themeSource = "dark";

  // These services are intentionally created in dependency order because downloader
  // relies on both persistence and structured logging during startup recovery.
  const logger = createLogger(app);
  const store = createStore(app, logger);
  const downloader = createDownloaderService({
    app,
    logger,
    store,
    onDownloadUpdate: (download) => broadcast("downloads:updated", download),
    onHistoryUpdate: (historyItem) => broadcast("history:updated", historyItem),
    onLogEntry: (entry) => broadcast("logs:append", entry),
    onSettingsUpdate: (settings) => broadcast("settings:updated", settings)
  });

  registerIpc({ store, logger, downloader });
  createMainWindow();

  downloader.warmup().catch((error) => {
    logger.warn("downloader.warmup.failed", {
      message: error.message
    });
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
