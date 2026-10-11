const { build } = require("./package.json");
const updateUrl = process.env.TUBEDECK_UPDATE_URL;
if (updateUrl && new URL(updateUrl).protocol !== "https:")
  throw new Error("TUBEDECK_UPDATE_URL must use HTTPS.");
module.exports = {
  ...build,
  asarUnpack: [...build.asarUnpack, "node_modules/ffprobe-static/**"],
  win: {
    ...build.win,
    signAndEditExecutable: Boolean(process.env.CSC_LINK),
    ...(process.env.TUBEDECK_PUBLISHER_NAME
      ? { publisherName: process.env.TUBEDECK_PUBLISHER_NAME }
      : {}),
  },
  ...(updateUrl ? { publish: [{ provider: "generic", url: updateUrl }] } : {}),
};
