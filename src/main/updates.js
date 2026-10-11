const fs = require("fs");
const path = require("path");
const createUpdateManager = ({ app, onUpdate }) => {
  const configured =
    app.isPackaged &&
    fs.existsSync(path.join(process.resourcesPath, "app-update.yml"));
  let state = {
    status: configured ? "idle" : "unconfigured",
    message: configured
      ? "Check for app updates."
      : "Updates are not available for this build.",
  };
  const update = (patch) => {
    state = { ...state, ...patch };
    onUpdate(state);
  };
  let updater;
  if (configured) {
    updater = require("electron-updater").autoUpdater;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.on("checking-for-update", () =>
      update({ status: "checking", message: "Checking for updates…" }),
    );
    updater.on("update-not-available", () =>
      update({ status: "idle", message: "TubeDeck is up to date." }),
    );
    updater.on("update-available", (info) =>
      update({
        status: "available",
        version: info.version,
        message: `Version ${info.version} is available.`,
      }),
    );
    updater.on("download-progress", (progress) =>
      update({
        status: "downloading",
        message: `Downloading update · ${Math.round(progress.percent)}%`,
      }),
    );
    updater.on("update-downloaded", () =>
      update({
        status: "downloaded",
        message: "Update ready. Restart to install.",
      }),
    );
    updater.on("error", () =>
      update({
        status: "error",
        message: "Could not check for updates. Try again later.",
      }),
    );
  }
  return {
    getState: () => ({ ...state }),
    check: async () => {
      if (!updater) return state;
      if (["checking", "downloading"].includes(state.status)) return state;
      try {
        if (state.status === "available") await updater.downloadUpdate();
        else await updater.checkForUpdates();
      } catch {
        update({
          status: "error",
          message: "Could not check for updates. Try again later.",
        });
      }
      return state;
    },
    install: () => {
      if (state.status === "downloaded") updater.quitAndInstall();
    },
  };
};
module.exports = { createUpdateManager };
