const VIDEO_ID = /^[\w-]{11}$/;
const QUALITY_PRESETS = { high: "0", balanced: "2", small: "128K" };
const youtubeUrl = (input) => {
  let url;
  try {
    url = new URL(String(input || "").trim());
  } catch {
    throw new Error("Enter a valid YouTube link.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    ![
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be",
    ].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error("Only YouTube links are supported.");
  url.protocol = "https:";
  return url;
};
const videoId = (input) => {
  try {
    const url = youtubeUrl(input);
    const id =
      url.hostname === "youtu.be"
        ? url.pathname.split("/")[1]
        : url.searchParams.get("v") ||
          (/^\/(shorts|embed|live)\//.test(url.pathname)
            ? url.pathname.split("/")[2]
            : "");
    return VIDEO_ID.test(id || "") ? id : "";
  } catch {
    return "";
  }
};
const watchUrl = (id) => {
  if (!VIDEO_ID.test(id || ""))
    throw new Error("This result is not a playable YouTube video.");
  return `https://www.youtube.com/watch?v=${id}`;
};
const durationLabel = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const total = Math.floor(seconds),
    hours = Math.floor(total / 3600),
    minutes = Math.floor(total / 60) % 60;
  return `${hours ? `${hours}:` : ""}${hours ? String(minutes).padStart(2, "0") : minutes}:${String(total % 60).padStart(2, "0")}`;
};
const sanitizeFileName = (value) => {
  const title =
    String(value || "TubeDeck MP3")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140)
      .replace(/[. ]+$/g, "") || "TubeDeck MP3";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(title)
    ? `${title}_`
    : title;
};
const normalizeMetadata = (metadata = {}, preview = {}) => ({
  title: String(metadata.title || preview.title || "TubeDeck MP3")
    .trim()
    .slice(0, 300),
  artist: String(metadata.artist ?? (preview.artist || preview.uploader || ""))
    .trim()
    .slice(0, 300),
  album: String(metadata.album ?? preview.album ?? "")
    .trim()
    .slice(0, 300),
  coverPath: String(metadata.coverPath || ""),
});
const fileName = (metadata) => `${sanitizeFileName(metadata.title)}.mp3`;
const safeImageUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
};
module.exports = {
  youtubeUrl,
  videoId,
  watchUrl,
  durationLabel,
  sanitizeFileName,
  normalizeMetadata,
  fileName,
  safeImageUrl,
  QUALITY_PRESETS,
  VIDEO_ID,
};
