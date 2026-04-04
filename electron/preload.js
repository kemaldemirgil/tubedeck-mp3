const { contextBridge, ipcRenderer } = require("electron");

// Expose a narrow, explicit bridge so the renderer never needs direct Node access.
contextBridge.exposeInMainWorld("tubeDeck", {
  getBootstrapState: () => ipcRenderer.invoke("app:get-bootstrap"),
  previewVideo: (url) => ipcRenderer.invoke("video:preview", url),
  downloadVideo: (payload) => ipcRenderer.invoke("video:download", payload),
  cancelDownload: (downloadId) => ipcRenderer.invoke("video:cancel", downloadId),
  chooseOutputDirectory: () => ipcRenderer.invoke("settings:choose-output-directory"),
  openPath: (targetPath) => ipcRenderer.invoke("shell:open-path", targetPath),
  showItemInFolder: (targetPath) => ipcRenderer.invoke("shell:show-item", targetPath),
  openLogsDirectory: () => ipcRenderer.invoke("shell:open-logs-directory"),
  onDownloadUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("downloads:updated", listener);

    return () => ipcRenderer.removeListener("downloads:updated", listener);
  },
  onHistoryUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("history:updated", listener);

    return () => ipcRenderer.removeListener("history:updated", listener);
  },
  onLogEntry: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("logs:append", listener);

    return () => ipcRenderer.removeListener("logs:append", listener);
  },
  onSettingsUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("settings:updated", listener);

    return () => ipcRenderer.removeListener("settings:updated", listener);
  }
});
