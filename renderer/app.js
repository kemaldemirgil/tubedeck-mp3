const state = {
  settings: {
    outputDirectory: ""
  },
  history: [],
  downloads: [],
  logs: [],
  preview: null,
  busy: false
};

// Cache stable DOM references once; the rest of the UI is rendered by updating sections in place.
const dom = {
  previewForm: document.querySelector("#previewForm"),
  videoUrl: document.querySelector("#videoUrl"),
  previewButton: document.querySelector("#previewButton"),
  previewPanel: document.querySelector("#previewPanel"),
  formMessage: document.querySelector("#formMessage"),
  statusBadge: document.querySelector("#statusBadge"),
  historyList: document.querySelector("#historyList"),
  historyItemTemplate: document.querySelector("#historyItemTemplate"),
  downloadItemTemplate: document.querySelector("#downloadItemTemplate"),
  activeDownloadsList: document.querySelector("#activeDownloadsList"),
  outputDirectoryLabel: document.querySelector("#outputDirectoryLabel"),
  activeCount: document.querySelector("#activeCount"),
  historyCount: document.querySelector("#historyCount"),
  historySummary: document.querySelector("#historySummary"),
  changeDirectoryButton: document.querySelector("#changeDirectoryButton"),
  openLogsButton: document.querySelector("#openLogsButton")
};

const numberFormatter = new Intl.NumberFormat();

const escapeHtml = (value = "") =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const timeAgo = (value) => {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const units = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60]
  ];

  for (const [unit, divisor] of units) {
    const delta = Math.round(seconds / divisor);
    if (Math.abs(delta) >= 1) {
      return formatter.format(delta, unit);
    }
  }

  return formatter.format(seconds, "second");
};

const statusTone = (status) => {
  if (status === "completed") {
    return "success";
  }

  if (status === "failed" || status === "canceled") {
    return "danger";
  }

  if (status === "running") {
    return "accent";
  }

  return "";
};

const setBusy = (busy, label) => {
  state.busy = busy;
  dom.previewButton.disabled = busy;
  dom.statusBadge.textContent = label;
  dom.statusBadge.className = `chip ${busy ? "accent" : "success"}`;
};

const setMessage = (message = "", tone = "") => {
  dom.formMessage.textContent = message;
  dom.formMessage.className = `form-message ${tone}`.trim();
};

const pluralize = (count, singular, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;

const renderOutputDirectory = () => {
  dom.outputDirectoryLabel.textContent = state.settings.outputDirectory || "Desktop";
};

const renderPreview = () => {
  if (!state.preview) {
    dom.previewPanel.className = "panel preview-panel empty-state";
    dom.previewPanel.innerHTML = `
      <div class="empty-illustration"></div>
      <div>
        <h2>No preview</h2>
        <p class="subtle-copy">Paste a link to load details.</p>
      </div>
    `;
    return;
  }

  const preview = state.preview;
  const description = preview.description ? `${escapeHtml(preview.description.slice(0, 88))}${preview.description.length > 88 ? "…" : ""}` : "";
  const views = preview.viewCount ? `${numberFormatter.format(preview.viewCount)} views` : "View count unavailable";
  const outputDirectory = escapeHtml(state.settings.outputDirectory || "Desktop");
  const descriptionMarkup = description ? `<p class="subtle-copy preview-description">${description}</p>` : "";

  dom.previewPanel.className = "panel preview-panel";
  dom.previewPanel.innerHTML = `
    <div class="preview-media">
      <img src="${escapeHtml(preview.thumbnail)}" alt="" />
    </div>
    <div class="preview-content">
      <div class="preview-topline">
        <span class="chip accent">Ready to download</span>
        <span class="chip">${escapeHtml(preview.durationLabel)}</span>
      </div>
      <h2>${escapeHtml(preview.title)}</h2>
      <p class="preview-meta">${escapeHtml(preview.uploader)} • ${escapeHtml(views)}</p>
      ${descriptionMarkup}
      <div class="preview-facts">
        <div class="preview-fact">
          <span class="label">Format</span>
          <strong>MP3</strong>
        </div>
        <div class="preview-fact">
          <span class="label">Folder</span>
          <strong>${outputDirectory}</strong>
        </div>
      </div>
      <div class="preview-actions">
        <button id="downloadButton" class="primary-button" type="button">Download</button>
        <button id="copyUrlButton" class="secondary-button" type="button">Keep</button>
      </div>
    </div>
  `;

  const downloadButton = document.querySelector("#downloadButton");
  const copyUrlButton = document.querySelector("#copyUrlButton");

  downloadButton.addEventListener("click", async () => {
    try {
      setMessage("Starting download…");
      setBusy(true, "Downloading");
      await window.tubeDeck.downloadVideo({
        url: state.preview.url,
        preview: state.preview,
        outputDirectory: state.settings.outputDirectory
      });
      setMessage(`Downloading "${state.preview.title}" to ${state.settings.outputDirectory}.`, "success");
    } catch (error) {
      setMessage(error.message, "danger");
    } finally {
      setBusy(false, "Ready");
    }
  });

  copyUrlButton.addEventListener("click", () => {
    dom.videoUrl.value = preview.url;
    setMessage("URL kept in the composer.", "success");
  });
};

const renderHistory = () => {
  dom.historyList.innerHTML = "";
  dom.historyCount.textContent = pluralize(state.history.length, "job");
  dom.historySummary.textContent = state.history.length
    ? `${state.history.filter((item) => item.status === "completed").length} complete`
    : "No jobs yet";

  if (!state.history.length) {
    dom.historyList.innerHTML = `<p class="subtle-copy">Completed and failed downloads show up here.</p>`;
    return;
  }

  state.history.forEach((item) => {
    const fragment = dom.historyItemTemplate.content.cloneNode(true);
    const button = fragment.querySelector(".history-item");
    const title = fragment.querySelector(".history-title");
    const meta = fragment.querySelector(".history-meta");
    const status = fragment.querySelector(".history-status");

    title.textContent = item.title || "Untitled video";
    meta.textContent = `${item.status.toUpperCase()} • ${timeAgo(item.startedAt)}${item.outputPath ? " • File ready" : ""}`;
    status.textContent = item.status;
    status.className = `history-status chip ${statusTone(item.status)}`.trim();

    button.addEventListener("click", async () => {
      if (item.outputPath) {
        await window.tubeDeck.showItemInFolder(item.outputPath);
        return;
      }

      if (item.outputDirectory) {
        await window.tubeDeck.openPath(item.outputDirectory);
      }
    });

    dom.historyList.appendChild(fragment);
  });
};

const renderDownloads = () => {
  // Only queued/running jobs stay in the active section; completed jobs live in history.
  const activeDownloads = state.downloads.filter((item) => ["queued", "running"].includes(item.status));

  dom.activeCount.textContent = pluralize(activeDownloads.length, "running job", "running jobs");
  dom.activeDownloadsList.innerHTML = "";

  if (!activeDownloads.length) {
    dom.activeDownloadsList.innerHTML = `<p class="subtle-copy">No active downloads.</p>`;
    return;
  }

  activeDownloads.forEach((download) => {
    const fragment = dom.downloadItemTemplate.content.cloneNode(true);
    const root = fragment.querySelector(".download-item");
    const title = fragment.querySelector(".download-title");
    const meta = fragment.querySelector(".download-meta");
    const actions = fragment.querySelector(".download-actions");
    const progressFill = fragment.querySelector(".progress-fill");
    const stats = fragment.querySelector(".download-stats");

    title.textContent = download.title || "Preparing download";
    meta.textContent = `${download.status.toUpperCase()} • ${download.uploader || "Unknown uploader"}`;
    progressFill.style.width = `${Math.max(4, download.progressPercent || 0)}%`;
    stats.textContent = download.status === "failed"
      ? download.errorMessage || "Download failed."
      : `${Math.round(download.progressPercent || 0)}% • ${download.speed || "Waiting for data"}${download.eta ? ` • ETA ${download.eta}` : ""}`;

    if (download.status === "running") {
      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "ghost-button";
      cancelButton.textContent = "Cancel";
      cancelButton.addEventListener("click", async () => {
        await window.tubeDeck.cancelDownload(download.id);
      });
      actions.appendChild(cancelButton);
    }

    root.classList.add(statusTone(download.status));
    dom.activeDownloadsList.appendChild(fragment);
  });
};

const render = () => {
  renderOutputDirectory();
  renderPreview();
  renderHistory();
  renderDownloads();
};

const bootstrap = async () => {
  // The renderer bootstraps from one payload so first paint is deterministic and easy to reason about.
  const initialState = await window.tubeDeck.getBootstrapState();
  state.settings = initialState.settings;
  state.history = initialState.history;
  state.downloads = initialState.downloads;
  state.logs = initialState.logs;
  render();

  const recoveredDownloads = initialState.runtime?.startupRecovery?.recoveredDownloads || 0;
  if (recoveredDownloads > 0) {
    setMessage(`Recovered ${pluralize(recoveredDownloads, "interrupted download")} from the previous session.`, "");
  }
};

dom.previewForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(true, "Previewing");
  setMessage("");

  try {
    const preview = await window.tubeDeck.previewVideo(dom.videoUrl.value);
    state.preview = preview;
    setMessage(`Preview loaded for "${preview.title}".`, "success");
    renderPreview();
  } catch (error) {
    state.preview = null;
    renderPreview();
    setMessage(error.message, "danger");
  } finally {
    setBusy(false, "Ready");
  }
});

dom.changeDirectoryButton.addEventListener("click", async () => {
  state.settings = await window.tubeDeck.chooseOutputDirectory();
  renderOutputDirectory();
  setMessage(`Downloads will go to ${state.settings.outputDirectory}.`, "success");
});

dom.openLogsButton.addEventListener("click", async () => {
  await window.tubeDeck.openLogsDirectory();
});

window.tubeDeck.onDownloadUpdate((download) => {
  const existingIndex = state.downloads.findIndex((item) => item.id === download.id);
  if (existingIndex >= 0) {
    state.downloads.splice(existingIndex, 1, download);
  } else {
    state.downloads.unshift(download);
  }

  renderDownloads();
});

window.tubeDeck.onHistoryUpdate((historyItem) => {
  const existingIndex = state.history.findIndex((item) => item.id === historyItem.id);
  if (existingIndex >= 0) {
    state.history.splice(existingIndex, 1);
  }
  state.history.unshift(historyItem);
  state.history = state.history.slice(0, 40);
  renderHistory();
});

window.tubeDeck.onLogEntry((entry) => {
  state.logs.unshift(entry);
  state.logs = state.logs.slice(0, 200);
});

window.tubeDeck.onSettingsUpdate((settings) => {
  state.settings = settings;
  renderOutputDirectory();
  renderPreview();
});

bootstrap().catch((error) => {
  setMessage(`Startup failed: ${error.message}`, "danger");
});
