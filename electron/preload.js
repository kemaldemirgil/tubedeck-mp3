const { contextBridge, ipcRenderer } = require("electron");
const invoke =
  (channel) =>
  (...args) =>
    ipcRenderer.invoke(channel, ...args);
const subscribe = (channel) => (callback) => {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld("tubeDeck", {
  getBootstrapState: invoke("app:get-bootstrap"),
  searchVideos: invoke("video:search"),
  previewVideo: invoke("video:preview"),
  fetchPlaylist: invoke("video:playlist"),
  downloadVideo: invoke("video:download"),
  enqueueBatch: invoke("video:batch"),
  cancelDownload: invoke("video:cancel"),
  retryDownload: invoke("video:retry"),
  planFileName: invoke("video:filename"),
  setQueuePaused: invoke("queue:pause"),
  resumeRecovery: invoke("queue:continue"),
  reorderQueue: invoke("queue:reorder"),
  getLibrary: invoke("library:get"),
  readClipboard: invoke("clipboard:read"),
  copyText: invoke("clipboard:write"),
  updateSettings: invoke("settings:update"),
  chooseOutputDirectory: invoke("settings:choose-output-directory"),
  chooseCover: invoke("settings:choose-cover"),
  openOutputDirectory: invoke("shell:open-output"),
  openPath: invoke("shell:open-path"),
  showItemInFolder: invoke("shell:show-item"),
  openYouTube: invoke("shell:open-youtube"),
  openLogsDirectory: invoke("shell:open-logs-directory"),
  repairTools: invoke("tools:repair"),
  checkForUpdates: invoke("updates:check"),
  installUpdate: invoke("updates:install"),
  onDownloadUpdate: subscribe("downloads:updated"),
  onHistoryUpdate: subscribe("history:updated"),
  onLibraryUpdate: subscribe("library:updated"),
  onQueueUpdate: subscribe("queue:updated"),
  onSettingsUpdate: subscribe("settings:updated"),
  onUpdateState: subscribe("updates:updated"),
});
