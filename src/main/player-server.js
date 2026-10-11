const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { VIDEO_ID } = require("./media");
const createPlayerServer = async ({
  rendererDirectory,
  getLibrary,
  coversDirectory,
}) => {
  const token = crypto.randomBytes(24).toString("hex");
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.searchParams.get("token") !== token) {
      response.writeHead(403).end();
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (
      url.pathname === "/player" &&
      VIDEO_ID.test(url.searchParams.get("id") || "")
    ) {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self' https://www.youtube.com https://s.ytimg.com; frame-src https://www.youtube.com; style-src 'unsafe-inline'; connect-src https://www.youtube.com; img-src https:;",
      );
      response.end(
        fs
          .readFileSync(path.join(rendererDirectory, "player.html"), "utf8")
          .replace(
            '<script id="bootstrap"></script>',
            `<script src="/player.js?token=${token}"></script>`,
          ),
      );
      return;
    }
    if (url.pathname === "/player.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(fs.readFileSync(path.join(rendererDirectory, "player.js")));
      return;
    }
    let target, mime;
    if (url.pathname === "/audio") {
      target = getLibrary().find(
        (item) => item.videoId === url.searchParams.get("id") && item.available,
      )?.outputPath;
      mime = "audio/mpeg";
    } else if (
      url.pathname === "/cover" &&
      /^[\w-]+\.(png|jpg|jpeg|webp)$/i.test(url.searchParams.get("name") || "")
    ) {
      target = path.join(coversDirectory, url.searchParams.get("name"));
      mime =
        "image/" +
        (path.extname(target).toLowerCase() === ".jpg"
          ? "jpeg"
          : path.extname(target).slice(1));
    }
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      response.writeHead(404).end();
      return;
    }
    const size = fs.statSync(target).size;
    const range = request.headers.range;
    let start = 0,
      end = size - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        response.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
        return;
      }
      if (!match[1]) start = Math.max(0, size - Number(match[2]));
      else start = Number(match[1]);
      if (match[1] && match[2]) end = Math.min(end, Number(match[2]));
      if (start > end || start >= size) {
        response.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
        return;
      }
    }
    response.writeHead(range ? 206 : 200, {
      "Content-Type": mime,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const stream = fs.createReadStream(target, { start, end });
    stream.on("error", () => response.destroy());
    response.on("close", () => stream.destroy());
    stream.pipe(response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    token,
    close: () => server.close(),
  };
};
module.exports = { createPlayerServer };
