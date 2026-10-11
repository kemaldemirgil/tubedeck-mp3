const { spawnSync } = require("child_process");
for (const name of [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "TUBEDECK_PUBLISHER_NAME",
  "TUBEDECK_UPDATE_URL",
]) {
  if (!process.env[name]) {
    process.stderr.write(
      "A signed release requires " +
        name +
        ". See README release instructions.\n",
    );
    process.exit(1);
  }
}
if (new URL(process.env.TUBEDECK_UPDATE_URL).protocol !== "https:")
  throw new Error("The update feed must use HTTPS.");
const result = spawnSync(
  process.execPath,
  [
    require.resolve("electron-builder/out/cli/cli.js"),
    "--config",
    "electron-builder.config.js",
    "--win",
    "nsis",
    "--publish",
    "never",
    "--config.forceCodeSigning=true",
  ],
  { stdio: "inherit", env: process.env },
);
process.exit(result.error || result.signal ? 1 : (result.status ?? 1));
