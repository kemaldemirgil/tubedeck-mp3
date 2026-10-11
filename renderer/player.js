const query = new URLSearchParams(location.search);
const notify = (type, detail) =>
  parent.postMessage(
    { source: "tubedeck-player", type, detail, videoId: query.get("id") },
    "*",
  );
window.onYouTubeIframeAPIReady = () => {
  new YT.Player("player", {
    videoId: query.get("id"),
    width: "100%",
    height: "100%",
    playerVars: {
      playsinline: 1,
      origin: location.origin,
      widget_referrer: "https://com.codex.tubedeckmp3/",
      autoplay: 0,
    },
    events: {
      onReady: () => notify("ready"),
      onStateChange: (event) => notify("state", event.data),
      onError: (event) => notify("error", event.data),
    },
  });
};
const api = document.createElement("script");
api.src = "https://www.youtube.com/iframe_api";
api.onerror = () => notify("error", "network");
document.head.appendChild(api);
setTimeout(() => {
  if (!document.querySelector("iframe")) notify("error", "timeout");
}, 20000);
