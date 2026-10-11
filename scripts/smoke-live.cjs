const fs = require("fs");
const path = require("path");
const os = require("os");
const { _electron: electron, expect } = require("@playwright/test");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tubedeck-live-"));
const output = path.join(directory, "output");
fs.mkdirSync(output);
fs.writeFileSync(
  path.join(directory, "state.json"),
  JSON.stringify({
    version: 3,
    settings: { outputDirectory: output, quality: "small", concurrency: 1 },
  }),
);
const cached =
  process.env.TUBEDECK_YTDLP_SOURCE ||
  path.join(process.env.APPDATA || "", "tubedeck-mp3", "bin", "yt-dlp.exe");
if (fs.existsSync(cached)) {
  fs.mkdirSync(path.join(directory, "bin"));
  fs.copyFileSync(cached, path.join(directory, "bin", "yt-dlp.exe"));
}
const env = { ...process.env, TUBEDECK_USER_DATA: directory };
delete env.ELECTRON_RUN_AS_NODE;
let application;
(async () => {
  application = await electron.launch({
    ...(process.env.TUBEDECK_EXECUTABLE
      ? { executablePath: process.env.TUBEDECK_EXECUTABLE, args: [] }
      : { args: [path.resolve(__dirname, "..")] }),
    env,
    timeout: 30000,
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  await page.locator("#videoUrl").fill("BLIMP What I Need");
  await page.locator("#previewButton").click();
  await expect(page.locator(".result-item").first()).toBeVisible({
    timeout: 90000,
  });
  console.log(
    "Live search results:",
    await page.locator(".result-item").count(),
  );
  await page
    .locator("#videoUrl")
    .fill("https://www.youtube.com/watch?v=jNQXAC9IVRw");
  await page.locator("#previewButton").click();
  await expect(page.locator("#previewTitle")).toHaveText("Me at the zoo", {
    timeout: 90000,
  });
  const embed = page
    .frameLocator("#youtubePlayerHost iframe")
    .frameLocator("iframe");
  try {
    await embed
      .getByRole("button", { name: /Play video|Play/ })
      .first()
      .click({ timeout: 30000 });
    await expect(page.locator("#playerMessage")).toContainText("Listening", {
      timeout: 20000,
    });
    console.log("Live embedded playback: playing");
  } catch {
    console.log(
      "Live embedded playback feedback:",
      await page.locator("#playerMessage").textContent(),
    );
  }
  const screenshots = path.resolve(
    __dirname,
    "../.tmp-smoke-output/screenshots",
  );
  fs.mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: path.join(screenshots, "live-player.png") });
  await page.locator("#downloadButton").click();
  await expect
    .poll(
      async () => {
        const state = JSON.parse(
          fs.readFileSync(path.join(directory, "state.json")),
        );
        return (
          state.history?.find((item) => item.videoId === "jNQXAC9IVRw")
            ?.status || "pending"
        );
      },
      { timeout: 150000 },
    )
    .not.toBe("pending");
  const state = JSON.parse(fs.readFileSync(path.join(directory, "state.json")));
  const result = state.history.find((item) => item.videoId === "jNQXAC9IVRw");
  if (result.status !== "completed")
    throw new Error(
      "Live download: " +
        result.errorMessage +
        "\n" +
        result.trace.map((entry) => entry.message).join("\n"),
    );
  console.log("Live MP3 verified:", JSON.stringify(result.validation));
  await page.locator("#playExistingButton").click();
  await expect
    .poll(() =>
      page.locator("#localAudio").evaluate((audio) => audio.readyState),
    )
    .toBeGreaterThan(0);
  console.log("Local MP3 playback: ready");
})()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (application) await application.close();
    // This directory was created solely for this smoke run, under the OS temporary directory.
    fs.rmSync(directory, { recursive: true, force: true });
  });
