const api = window.tubeDeck;
const state = {
  settings: {},
  history: [],
  downloads: [],
  library: [],
  results: [],
  preview: null,
  cover: null,
  busy: false,
  paused: false,
  player: null,
  searchQuery: "",
  searchCount: 12,
  playlistUrl: "",
  playlist: [],
};
const $ = (id) => document.getElementById(id);
const escapeHtml = (value = "") =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const ACTIVE = [
  "queued",
  "preparing",
  "downloading",
  "converting",
  "verifying",
  "retrying",
  "interrupted",
];
const labels = {
  queued: "Queued",
  preparing: "Preparing",
  downloading: "Downloading",
  converting: "Converting",
  verifying: "Verifying file",
  completed: "Complete",
  failed: "Failed",
  canceled: "Canceled",
  retrying: "Retrying",
  interrupted: "Interrupted",
};
const tone = (status) =>
  status === "completed"
    ? "success"
    : status === "failed"
      ? "danger"
      : ACTIVE.includes(status)
        ? "accent"
        : "";
let requestNumber = 0,
  selectionNumber = 0,
  filenameNumber = 0;
const message = (text = "", type = "") => {
  $("formMessage").textContent = text;
  $("formMessage").className = "form-message " + type;
  $("formMessage").setAttribute("role", type === "danger" ? "alert" : "status");
  $("formMessage").setAttribute(
    "aria-live",
    type === "danger" ? "assertive" : "polite",
  );
};
const safely =
  (callback) =>
  async (...args) => {
    try {
      await callback(...args);
    } catch (error) {
      message(error.message, "danger");
    }
  };
const folderName = () =>
  (state.settings.outputDirectory || "Desktop")
    .split(/[\\/]/)
    .filter(Boolean)
    .at(-1);
const selectedJob = () =>
  state.downloads
    .filter((job) => job.videoId === state.preview?.id)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0];
const existingFile = () =>
  state.library.find(
    (item) => item.videoId === state.preview?.id && item.available,
  );
const metadata = () => ({
  title: $("metadataTitle").value,
  artist: $("metadataArtist").value,
  album: $("metadataAlbum").value,
  coverPath: state.cover?.path || "",
});
const timeAgo = (date) => {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(date)) / 1000));
  return seconds < 60
    ? "Just now"
    : seconds < 3600
      ? Math.floor(seconds / 60) + "m ago"
      : seconds < 86400
        ? Math.floor(seconds / 3600) + "h ago"
        : new Date(date).toLocaleDateString();
};
const button = (text, action, id, style = "text-button", label = text) =>
  '<button class="' +
  style +
  '" data-action="' +
  action +
  '" data-id="' +
  escapeHtml(id) +
  '" aria-label="' +
  escapeHtml(label) +
  '">' +
  text +
  "</button>";
const renderStatus = () => {
  const job = selectedJob(),
    active = state.downloads.filter((item) => ACTIVE.includes(item.status));
  const current = state.busy
    ? "Searching…"
    : active.length
      ? state.paused
        ? "Queue paused"
        : active.filter(
            (item) => !["queued", "interrupted"].includes(item.status),
          ).length + " active"
      : job
        ? labels[job.status]
        : existingFile()
          ? "Already downloaded"
          : "Ready";
  $("statusBadge").textContent = current;
  $("statusBadge").className =
    "chip " + (active.length ? "accent" : job ? tone(job.status) : "");
  if (!state.preview) return;
  $("previewStage").textContent = job
    ? labels[job.status] +
      (job.status === "downloading"
        ? " · " + Math.round(job.progressPercent) + "%"
        : "")
    : existingFile()
      ? "Already downloaded"
      : "Ready to download";
  $("previewStage").className =
    "chip " + (job ? tone(job.status) : existingFile() ? "success" : "");
  const inProgress = job && ACTIVE.includes(job.status);
  $("downloadButton").disabled = Boolean(inProgress);
  $("downloadButton").textContent = inProgress
    ? labels[job.status] + "…"
    : "Download MP3";
  $("downloadButton").hidden = Boolean(existingFile() && !inProgress);
  $("existingActions").hidden = !existingFile();
  $("previewFacts").textContent = "MP3 · Save to " + folderName();
  $("previewFacts").title = state.settings.outputDirectory;
};
const renderQueue = () => {
  const jobs = state.downloads.filter((job) => ACTIVE.includes(job.status));
  $("activeCount").textContent = jobs.length || "";
  $("pauseQueueButton").textContent = state.paused ? "Resume" : "Pause";
  $("pauseQueueButton").disabled = !jobs.length;
  $("queueMessage").textContent = state.paused
    ? "Queue paused. Current downloads can finish."
    : jobs.length
      ? "Up to " + state.settings.concurrency + " downloads at once"
      : "No downloads waiting.";
  $("activeDownloadsList").innerHTML = jobs
    .map((job) => {
      const moving = job.status === "queued",
        percent = Math.max(0, Math.min(100, job.progressPercent || 0));
      return (
        '<article class="download-item"><div class="item-heading"><p class="item-title">' +
        escapeHtml(job.title) +
        '</p><span class="chip ' +
        tone(job.status) +
        '">' +
        labels[job.status] +
        "</span></div>" +
        (!["queued", "interrupted"].includes(job.status)
          ? '<progress max="100" value="' +
            percent +
            '" aria-label="' +
            escapeHtml(job.title + " download progress") +
            '"></progress>'
          : "") +
        '<p class="item-meta">' +
        escapeHtml(
          job.errorMessage ||
            (job.status === "downloading"
              ? Math.round(percent) +
                "% · " +
                (job.speed || "Connecting") +
                (job.eta ? " · " + job.eta + " left" : "")
              : ""),
        ) +
        '</p><div class="item-actions">' +
        (job.status === "interrupted"
          ? button("Continue", "retry", job.id)
          : "") +
        (moving
          ? button("↑", "up", job.id, "text-button", "Move download earlier") +
            button("↓", "down", job.id, "text-button", "Move download later")
          : "") +
        button("Cancel", "cancel", job.id) +
        button("Details", "details", job.id) +
        "</div></article>"
      );
    })
    .join("");
  $("recoveryBanner").hidden = !jobs.some(
    (job) => job.status === "interrupted",
  );
  $("recoveryMessage").textContent =
    jobs.filter((job) => job.status === "interrupted").length +
    " interrupted download(s) are ready to continue.";
  renderStatus();
};
const renderHistory = () => {
  const groups = new Map();
  for (const item of state.history.filter(
    (job) => !ACTIVE.includes(job.status),
  )) {
    const key = item.videoId || item.url || item.id;
    if (!groups.has(key)) groups.set(key, { item, attempts: 0 });
    groups.get(key).attempts++;
  }
  $("historyCount").textContent = groups.size ? groups.size + " tracks" : "";
  $("historySummary").textContent =
    state.history.filter((item) => item.status === "completed").length +
    " completed";
  $("historyList").innerHTML = groups.size
    ? [...groups.values()]
        .map(({ item, attempts }) => {
          const file = state.library.find(
            (entry) => entry.videoId === item.videoId && entry.available,
          );
          return (
            '<article class="history-item"><div class="item-heading"><p class="item-title">' +
            escapeHtml(item.title) +
            '</p><span class="chip ' +
            tone(item.status) +
            '">' +
            labels[item.status] +
            '</span></div><p class="item-meta">' +
            escapeHtml(
              timeAgo(item.completedAt || item.startedAt) +
                (attempts > 1 ? " · " + attempts + " attempts" : "") +
                (item.status === "completed" && !file ? " · File missing" : ""),
            ) +
            "</p>" +
            (item.errorMessage
              ? '<p class="item-error">' +
                escapeHtml(item.errorMessage) +
                "</p>"
              : "") +
            '<div class="item-actions">' +
            (file
              ? button("Play", "play", item.id) +
                button("Show file", "show", item.id)
              : item.status === "completed"
                ? button("Download again", "again", item.id)
                : "") +
            (["failed", "canceled"].includes(item.status)
              ? button("Retry", "retry", item.id)
              : "") +
            button("Details", "details", item.id) +
            "</div></article>"
          );
        })
        .join("")
    : '<p class="subtle-copy empty-copy">Your downloaded tracks will appear here.</p>';
};
const renderResults = () => {
  $("resultsPanel").hidden = !state.results.length;
  $("resultCount").textContent = state.results.length;
  $("resultsTitle").textContent = "YouTube results";
  $("resultsList").innerHTML = state.results
    .map(
      (result) =>
        '<button class="result-item ' +
        (result.id === state.preview?.id ? "selected" : "") +
        '" data-video="' +
        escapeHtml(result.id) +
        '" aria-pressed="' +
        (result.id === state.preview?.id) +
        '"><img src="' +
        escapeHtml(result.thumbnail) +
        '" alt="" loading="lazy"><span class="result-copy"><strong>' +
        escapeHtml(result.title) +
        "</strong><span>" +
        escapeHtml(result.uploader) +
        "</span><small>" +
        escapeHtml(result.durationLabel) +
        "</small></span></button>",
    )
    .join("");
  $("moreResultsButton").hidden = !state.searchQuery || state.searchCount >= 48;
  $("moreResultsButton").disabled = state.busy;
};
const updateFilename = async () => {
  const sequence = ++filenameNumber;
  const filename = await api.planFileName(metadata());
  if (sequence === filenameNumber) $("fileNamePreview").textContent = filename;
};
const selectVideo = async (result, fetchDetails = true) => {
  const sequence = ++selectionNumber;
  state.preview = result;
  state.cover = null;
  $("emptyPreview").hidden = true;
  $("selectedPreview").hidden = false;
  $("previewTitle").textContent = result.title;
  $("previewMeta").textContent = result.uploader + " · " + result.durationLabel;
  $("metadataTitle").value = result.title;
  $("metadataArtist").value = result.artist || result.uploader;
  $("metadataAlbum").value = result.album || "";
  $("coverPreview").src = result.thumbnail;
  $("metadataDetails").open = false;
  $("localAudio").pause();
  $("localPlayer").hidden = true;
  $("playerMessage").textContent = "Loading YouTube player…";
  const frame = document.createElement("iframe");
  frame.title = "Listen to " + result.title;
  frame.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
  frame.setAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-presentation",
  );
  frame.src =
    state.player.base +
    "/player?id=" +
    result.id +
    "&token=" +
    state.player.token;
  $("youtubePlayerHost").replaceChildren(frame);
  renderResults();
  renderStatus();
  void updateFilename();
  state.library = await api.getLibrary();
  if (sequence !== selectionNumber) return;
  renderStatus();
  if (fetchDetails) {
    try {
      const preview = await api.previewVideo(result.url);
      if (sequence !== selectionNumber) return;
      state.preview = preview;
      $("previewMeta").textContent =
        preview.uploader + " · " + preview.durationLabel;
      if (!result.artist && $("metadataArtist").value === result.uploader)
        $("metadataArtist").value = preview.artist || preview.uploader;
      if (!$("metadataAlbum").value)
        $("metadataAlbum").value = preview.album || "";
      renderStatus();
    } catch (error) {
      if (sequence === selectionNumber)
        message(
          "The player is ready. Video details could not load: " + error.message,
          "danger",
        );
    }
  }
};
const queueSelected = async (downloadAgain = false) => {
  if (!state.preview || $("downloadButton").disabled) return;
  const preview = { ...state.preview },
    title = $("metadataTitle").value || preview.title;
  $("downloadButton").disabled = true;
  try {
    const reply = await api.downloadVideo({
      url: preview.url,
      preview,
      metadata: metadata(),
      quality: $("qualitySelect").value,
      downloadAgain,
    });
    if (reply.alreadyDownloaded) {
      state.library = await api.getLibrary();
      message("Already downloaded. Play it or show the file.", "success");
    } else {
      const job = state.downloads.find((item) => item.id === reply.id);
      if (!job || ACTIVE.includes(job.status))
        message(
          reply.duplicate
            ? "This track is already in the queue."
            : '"' + title + '" added to the queue.',
        );
    }
  } finally {
    renderStatus();
  }
};
const playFile = async (item) => {
  state.library = await api.getLibrary();
  const file = state.library.find(
    (entry) => entry.videoId === item.videoId && entry.available,
  );
  if (!file) {
    renderHistory();
    renderStatus();
    throw new Error("This MP3 is missing. Download it again to restore it.");
  }
  $("youtubePlayerHost").replaceChildren();
  $("playerMessage").textContent = "Playing your downloaded MP3.";
  $("localTitle").textContent = file.title;
  $("localPlayer").hidden = false;
  $("localAudio").src =
    state.player.base +
    "/audio?id=" +
    file.videoId +
    "&token=" +
    state.player.token;
  await $("localAudio").play();
};
const showDetails = (item) => {
  $("detailsTitle").textContent = item.title;
  $("detailsMessage").textContent = item.errorMessage || labels[item.status];
  $("detailsTrace").textContent =
    (item.trace || [])
      .map((entry) => entry.timestamp + " · " + entry.message)
      .join("\n") || "No additional details.";
  $("detailsDialog").showModal();
};
const renderSettings = () => {
  $("outputDirectoryLabel").textContent = state.settings.outputDirectory;
  $("outputDirectoryLabel").title = state.settings.outputDirectory;
  $("defaultQuality").value = state.settings.quality;
  $("qualitySelect").value = state.settings.quality;
  $("concurrencySelect").value = state.settings.concurrency;
  $("notificationsCheckbox").checked = state.settings.notifications;
  renderStatus();
  renderQueue();
};
const showPlaylist = (url) => {
  state.playlistUrl = url;
  state.playlist = [];
  $("playlistTitle").textContent = "Playlist link";
  $("playlistMessage").textContent =
    "Download this video, or choose tracks from the playlist.";
  $("playlistTracks").hidden = true;
  $("playlistSelectionActions").hidden = true;
  $("thisVideoButton").disabled =
    !new URL(url).searchParams.get("v") &&
    !/youtu\.be|\/shorts\/|\/live\//.test(url);
  $("chooseTracksButton").disabled = false;
  $("chooseTracksButton").hidden = false;
  $("playlistDialog").showModal();
};
const setSearchBusy = (value) => {
  state.busy = value;
  $("previewButton").disabled = value;
  $("moreResultsButton").disabled = value;
  renderStatus();
};
$("previewForm").addEventListener(
  "submit",
  safely(async (event) => {
    event.preventDefault();
    const input = $("videoUrl").value.trim();
    if (!input) throw new Error("Search for a song or paste a YouTube link.");
    if (
      /^https?:\/\//i.test(input) &&
      new URL(input).searchParams.has("list")
    ) {
      showPlaylist(input);
      return;
    }
    const sequence = ++requestNumber;
    setSearchBusy(true);
    message("Searching…");
    try {
      if (/^https?:\/\//i.test(input)) {
        const result = await api.previewVideo(input);
        if (sequence !== requestNumber) return;
        await selectVideo(result, false);
        message("Press play to check this version.");
      } else {
        state.searchQuery = input;
        state.searchCount = 12;
        const results = await api.searchVideos(input, state.searchCount);
        if (sequence !== requestNumber) return;
        state.results = results;
        renderResults();
        message(
          results.length
            ? "Choose a result to listen."
            : "No results. Try another song or artist.",
        );
      }
    } finally {
      if (sequence === requestNumber) {
        setSearchBusy(false);
      }
    }
  }),
);
$("resultsList").addEventListener(
  "click",
  safely(async (event) => {
    const element = event.target.closest("[data-video]");
    if (element)
      await selectVideo(
        state.results.find((result) => result.id === element.dataset.video),
      );
  }),
);
$("moreResultsButton").addEventListener(
  "click",
  safely(async () => {
    if (state.busy) return;
    const sequence = ++requestNumber;
    setSearchBusy(true);
    try {
      const count = Math.min(48, state.searchCount + 12);
      const results = await api.searchVideos(state.searchQuery, count);
      if (sequence !== requestNumber) return;
      state.searchCount = count;
      state.results = results;
      renderResults();
    } finally {
      if (sequence === requestNumber) setSearchBusy(false);
    }
  }),
);
$("pasteButton").addEventListener(
  "click",
  safely(async () => {
    const text = (await api.readClipboard()).trim();
    if (text.split(/\r?\n/).filter(Boolean).length > 1) {
      $("batchUrls").value = text;
      $("batchDialog").showModal();
    } else {
      $("videoUrl").value = text;
      $("videoUrl").focus();
    }
  }),
);
$("downloadButton").addEventListener(
  "click",
  safely(() => queueSelected()),
);
$("downloadAgainButton").addEventListener(
  "click",
  safely(() => queueSelected(true)),
);
$("playExistingButton").addEventListener(
  "click",
  safely(() => playFile(existingFile())),
);
$("showExistingButton").addEventListener(
  "click",
  safely(() => api.showItemInFolder(existingFile().outputPath)),
);
$("openYouTubeButton").addEventListener(
  "click",
  safely(() => api.openYouTube(state.preview.url)),
);
$("openFolderButton").addEventListener(
  "click",
  safely(() => api.openOutputDirectory()),
);
$("changeDirectoryButton").addEventListener(
  "click",
  safely(async () => {
    state.settings = await api.chooseOutputDirectory();
    renderSettings();
  }),
);
$("pauseQueueButton").addEventListener(
  "click",
  safely(async () => {
    state.paused = (
      state.paused ? await api.resumeRecovery() : await api.setQueuePaused(true)
    ).paused;
    renderQueue();
  }),
);
$("continueButton").addEventListener(
  "click",
  safely(async () => {
    state.paused = (await api.resumeRecovery()).paused;
    renderQueue();
  }),
);
const itemAction = safely(async (event) => {
  const element = event.target.closest("[data-action]");
  if (!element) return;
  const { action, id } = element.dataset;
  const item =
    state.downloads.find((entry) => entry.id === id) ||
    state.history.find((entry) => entry.id === id);
  if (action === "details") showDetails(item);
  if (action === "retry") await api.retryDownload(id);
  if (action === "cancel") await api.cancelDownload(id);
  if (action === "play") await playFile(item);
  if (action === "show") {
    const file = state.library.find(
      (entry) => entry.videoId === item.videoId && entry.available,
    );
    await api.showItemInFolder(file.outputPath);
  }
  if (action === "again")
    await api.downloadVideo({
      url: item.url,
      preview: item.preview,
      metadata: item.metadata,
      quality: item.quality,
      downloadAgain: true,
    });
  if (action === "up" || action === "down") {
    state.downloads = await api.reorderQueue(id, action === "up" ? -1 : 1);
    renderQueue();
  }
});
$("activeDownloadsList").addEventListener("click", itemAction);
$("historyList").addEventListener("click", itemAction);
$("batchButton").addEventListener("click", () => {
  $("batchMessage").textContent = "";
  $("batchDialog").showModal();
});
$("enqueueBatchButton").addEventListener("click", async () => {
  $("enqueueBatchButton").disabled = true;
  try {
    const urls = [
      ...new Set(
        $("batchUrls")
          .value.split(/\r?\n/)
          .map((url) => url.trim())
          .filter(Boolean),
      ),
    ];
    if (!urls.length) throw new Error("Paste at least one YouTube video link.");
    if (
      urls.some((url) => {
        try {
          return new URL(url).searchParams.has("list");
        } catch {
          return false;
        }
      })
    )
      throw new Error(
        "Add playlist links through the search field to choose their tracks.",
      );
    const replies = await api.enqueueBatch(
      urls.map((url) => ({ url, quality: state.settings.quality })),
    );
    $("batchDialog").close();
    message(
      replies.length +
        " links processed. Previously downloaded or queued tracks were skipped.",
    );
  } catch (error) {
    $("batchMessage").textContent = error.message;
  } finally {
    $("enqueueBatchButton").disabled = false;
  }
});
$("thisVideoButton").addEventListener(
  "click",
  safely(async () => {
    $("playlistDialog").close();
    const result = await api.previewVideo(state.playlistUrl);
    await selectVideo(result, false);
  }),
);
$("chooseTracksButton").addEventListener("click", async () => {
  $("chooseTracksButton").disabled = true;
  $("playlistMessage").textContent = "Loading playlist tracks…";
  try {
    const playlist = await api.fetchPlaylist(state.playlistUrl);
    state.playlist = playlist.results;
    $("playlistTitle").textContent = playlist.title;
    $("playlistMessage").textContent = playlist.results.length
      ? "Select the tracks you want." +
        (playlist.limited ? " Showing the first 100 tracks." : "")
      : "No playable tracks were found.";
    $("playlistTracks").innerHTML = playlist.results
      .map(
        (item) =>
          '<label class="playlist-track"><input type="checkbox" value="' +
          escapeHtml(item.id) +
          '"><span><strong>' +
          escapeHtml(item.title) +
          "</strong><small>" +
          escapeHtml(item.uploader + " · " + item.durationLabel) +
          "</small></span></label>",
      )
      .join("");
    $("playlistTracks").hidden = false;
    $("playlistSelectionActions").hidden = !playlist.results.length;
    $("chooseTracksButton").hidden = true;
  } catch (error) {
    $("playlistMessage").textContent = error.message;
  } finally {
    $("chooseTracksButton").disabled = false;
  }
});
$("selectAllTracksButton").addEventListener("click", () => {
  const boxes = [...$("playlistTracks").querySelectorAll("input")],
    checked = boxes.some((box) => !box.checked);
  boxes.forEach((box) => (box.checked = checked));
  $("selectAllTracksButton").textContent = checked
    ? "Deselect all"
    : "Select all";
});
$("enqueueTracksButton").addEventListener(
  "click",
  safely(async () => {
    const ids = [...$("playlistTracks").querySelectorAll("input:checked")].map(
      (input) => input.value,
    );
    if (!ids.length) {
      $("playlistMessage").textContent = "Select at least one track.";
      return;
    }
    $("enqueueTracksButton").disabled = true;
    try {
      await api.enqueueBatch(
        state.playlist
          .filter((item) => ids.includes(item.id))
          .map((preview) => ({
            url: preview.url,
            preview,
            quality: state.settings.quality,
          })),
      );
      $("playlistDialog").close();
      message(ids.length + " selected tracks added.");
    } finally {
      $("enqueueTracksButton").disabled = false;
    }
  }),
);
for (const id of ["metadataTitle", "metadataArtist", "metadataAlbum"])
  $(id).addEventListener("input", safely(updateFilename));
$("chooseCoverButton").addEventListener(
  "click",
  safely(async () => {
    const cover = await api.chooseCover();
    if (cover) {
      state.cover = cover;
      $("coverPreview").src = cover.url;
    }
  }),
);
$("resetCoverButton").addEventListener("click", () => {
  state.cover = null;
  $("coverPreview").src = state.preview.thumbnail;
});
$("settingsButton").addEventListener("click", () =>
  $("settingsDialog").showModal(),
);
document
  .querySelectorAll("[data-close]")
  .forEach((element) =>
    element.addEventListener("click", () => $(element.dataset.close).close()),
  );
const saveSettings = safely(async () => {
  state.settings = await api.updateSettings({
    quality: $("defaultQuality").value,
    concurrency: Number($("concurrencySelect").value),
    notifications: $("notificationsCheckbox").checked,
  });
  renderSettings();
});
for (const id of [
  "defaultQuality",
  "concurrencySelect",
  "notificationsCheckbox",
])
  $(id).addEventListener("change", saveSettings);
$("repairToolsButton").addEventListener("click", async () => {
  $("repairToolsButton").disabled = true;
  $("diagnostics").hidden = false;
  $("diagnostics").textContent = "Checking and repairing tools…";
  try {
    const report = await api.repairTools();
    $("diagnostics").textContent =
      "All download tools are ready.\n\nyt-dlp " +
      report.ytDlp +
      "\n" +
      report.ffmpeg +
      "\n" +
      report.ffprobe +
      "\nChecked " +
      new Date(report.checkedAt).toLocaleString();
  } catch (error) {
    $("diagnostics").textContent = error.message;
  } finally {
    $("repairToolsButton").disabled = false;
    $("copyDiagnosticsButton").hidden = false;
  }
});
$("copyDiagnosticsButton").addEventListener(
  "click",
  safely(() => api.copyText($("diagnostics").textContent)),
);
$("copyDetailsButton").addEventListener(
  "click",
  safely(() =>
    api.copyText(
      $("detailsTitle").textContent +
        "\n" +
        $("detailsMessage").textContent +
        "\n" +
        $("detailsTrace").textContent,
    ),
  ),
);
$("openLogsButton").addEventListener(
  "click",
  safely(() => api.openLogsDirectory()),
);
const renderUpdates = (update) => {
  $("updateMessage").textContent = update.message;
  $("checkUpdatesButton").disabled = [
    "unconfigured",
    "checking",
    "downloading",
  ].includes(update.status);
  $("checkUpdatesButton").textContent =
    update.status === "available"
      ? "Download update"
      : update.status === "downloaded"
        ? "Restart and install"
        : "Check for updates";
  $("checkUpdatesButton").dataset.state = update.status;
};
$("checkUpdatesButton").addEventListener(
  "click",
  safely(async () => {
    if ($("checkUpdatesButton").dataset.state === "downloaded")
      await api.installUpdate();
    else renderUpdates(await api.checkForUpdates());
  }),
);
$("closeLocalButton").addEventListener("click", () => {
  $("localAudio").pause();
  $("localPlayer").hidden = true;
  if (state.preview) safely(() => selectVideo(state.preview, false))();
});
$("localAudio").addEventListener("error", () =>
  message(
    "This MP3 could not be played. Check that the file is still available.",
    "danger",
  ),
);
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === "l") {
    event.preventDefault();
    $("videoUrl").focus();
    $("videoUrl").select();
  }
  if (
    event.ctrlKey &&
    event.key === "Enter" &&
    !document.querySelector("dialog[open]")
  ) {
    event.preventDefault();
    safely(() => queueSelected())();
  }
});
window.addEventListener("message", (event) => {
  const frame = $("youtubePlayerHost").querySelector("iframe");
  if (
    !frame ||
    event.source !== frame.contentWindow ||
    event.origin !== state.player?.base ||
    event.data?.source !== "tubedeck-player" ||
    event.data.videoId !== state.preview?.id
  )
    return;
  if (event.data.type === "error")
    $("playerMessage").textContent = [101, 150].includes(event.data.detail)
      ? "This video blocks embedded playback. Open it in YouTube to listen."
      : "YouTube playback is unavailable here. Try Open in YouTube.";
  if (event.data.type === "ready")
    $("playerMessage").textContent = "Press play to listen before downloading.";
  if (event.data.type === "state" && event.data.detail === 1)
    $("playerMessage").textContent =
      "Listening · Download MP3 when you find the right version.";
});
api.onDownloadUpdate((job) => {
  const index = state.downloads.findIndex((item) => item.id === job.id);
  if (index >= 0) state.downloads[index] = job;
  else state.downloads.push(job);
  renderQueue();
  if (job.videoId === state.preview?.id || !state.preview) {
    if (job.status === "failed") message(job.errorMessage, "danger");
    if (job.status === "completed")
      message('"' + job.title + '" saved and verified.', "success");
    if (job.status === "canceled") message("Download canceled.");
  }
});
api.onHistoryUpdate((item) => {
  state.history = [
    item,
    ...state.history.filter((entry) => entry.id !== item.id),
  ].slice(0, 40);
  renderHistory();
});
api.onLibraryUpdate((library) => {
  state.library = library;
  renderHistory();
  renderStatus();
});
api.onQueueUpdate((queue) => {
  state.paused = queue.paused;
  renderQueue();
});
api.onSettingsUpdate((settings) => {
  state.settings = settings;
  renderSettings();
});
api.onUpdateState(renderUpdates);
const bootstrap = async () => {
  const initial = await api.getBootstrapState();
  state.settings = initial.settings;
  state.history = initial.history;
  state.downloads = initial.downloads;
  state.library = initial.library;
  state.player = initial.runtime.player;
  state.paused = initial.runtime.queue.paused;
  $("appVersion").textContent = initial.runtime.version;
  renderSettings();
  renderHistory();
  renderUpdates(initial.runtime.updates);
  if (initial.runtime.startupRecovery.recoveredDownloads)
    message(
      "Your previous queue is saved. Continue downloads when you are ready.",
    );
};
bootstrap().catch((error) =>
  message("Startup failed: " + error.message, "danger"),
);
