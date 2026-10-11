const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { test } = require("node:test");
const { _electron: electron, expect } = require("@playwright/test");
test(
  "desktop search, playback, metadata, queue, playlists, errors and saved window state",
  { timeout: 90000 },
  async (t) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "tubedeck-desktop-"),
    );
    const env = { ...process.env, TUBEDECK_USER_DATA: directory };
    delete env.ELECTRON_RUN_AS_NODE;
    let application;
    t.after(async () => {
      if (application) await application.close();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    application = await electron.launch({
      args: [path.join(__dirname, "desktop-fixture.cjs")],
      env,
      timeout: 20000,
    });
    const page = await application.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("https://www.youtube.com/embed/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<html><body style="background:#090f16;color:white">YouTube preview fixture</body></html>',
      }),
    );
    await page.route("https://www.youtube.com/iframe_api", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: `window.YT={Player:function(id,config){window.testPlayerEvents=config.events;document.getElementById(id).innerHTML='<iframe style="width:100%;height:100%;border:0" src="https://www.youtube.com/embed/'+config.videoId+'"></iframe>';config.events.onReady();}};window.onYouTubeIframeAPIReady();`,
      }),
    );
    await page.locator("#videoUrl").fill("blimp what i need");
    await page.locator("#previewButton").click();
    await expect(page.locator(".result-item")).toHaveCount(3);
    await page.locator(".result-item").first().click();
    await expect(page.locator("#previewTitle")).toHaveText("What I Need");
    await expect(page.locator("#youtubePlayerHost iframe")).toHaveCount(1);
    await expect(
      page.frameLocator("#youtubePlayerHost iframe").locator("iframe"),
    ).toBeVisible();
    if (process.env.TUBEDECK_SCREENSHOTS) {
      fs.mkdirSync(process.env.TUBEDECK_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: path.join(process.env.TUBEDECK_SCREENSHOTS, "search-player.png"),
      });
    }
    await expect(page.locator("#playerMessage")).toHaveText(
      "Press play to listen before downloading.",
    );
    await page.locator("#metadataDetails summary").click();
    await page.locator("#metadataTitle").fill("My edited track");
    await page.locator("#metadataArtist").fill("My artist");
    await page.locator("#metadataAlbum").fill("My album");
    await expect(page.locator("#fileNamePreview")).toHaveText(
      "My edited track.mp3",
    );
    await page.locator("#qualitySelect").selectOption("small");
    await page.locator("#downloadButton").click();
    await expect(page.locator("#existingActions")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator("#historyList .chip").first()).toHaveText(
      "Complete",
    );
    await page.locator("#playExistingButton").click();
    await expect(page.locator("#localPlayer")).toBeVisible();
    await expect
      .poll(() =>
        page.locator("#localAudio").evaluate((audio) => audio.readyState),
      )
      .toBeGreaterThan(0);
    const saved = JSON.parse(
      fs.readFileSync(path.join(directory, "state.json")),
    );
    assert.equal(saved.library[0].validation.tags.artist, "My artist");
    assert.equal(saved.library[0].validation.artwork, true);
    await page.locator("#closeLocalButton").click();
    await page.locator(".result-item").nth(2).click();
    await page.locator("#downloadButton").click();
    await expect(page.locator("#formMessage")).toHaveText(
      "This video is unavailable.",
    );
    await expect(page.locator("#historyList")).toContainText("Retry");
    await expect(page.locator("#previewStage")).toHaveText("Failed");
    await page
      .locator("#videoUrl")
      .fill("https://www.youtube.com/watch?v=s_oktKc_wyo&list=PLfixture");
    await page.locator("#previewButton").click();
    await expect(page.locator("#playlistDialog")).toBeVisible();
    await page.locator("#chooseTracksButton").click();
    await expect(page.locator(".playlist-track")).toHaveCount(3);
    await page.locator(".playlist-track input").nth(1).check();
    await page.locator("#enqueueTracksButton").click();
    await expect(page.locator("#historyList")).toContainText("Quiet Evening", {
      timeout: 10000,
    });
    await page.locator("#settingsButton").click();
    await page.locator("#concurrencySelect").selectOption("1");
    await page.locator("#repairToolsButton").click();
    await expect(page.locator("#diagnostics")).toContainText(
      "All download tools are ready.",
    );
    await page.locator('[data-close="settingsDialog"]').click();
    await page.keyboard.press("Control+l");
    await expect(page.locator("#videoUrl")).toBeFocused();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setBounds({
        x: 30,
        y: 40,
        width: 1100,
        height: 740,
      }),
    );
    if (process.env.TUBEDECK_SCREENSHOTS)
      await page.screenshot({
        path: path.join(process.env.TUBEDECK_SCREENSHOTS, "downloads.png"),
      });
    assert.deepEqual(errors, []);
    await application.close();
    application = null;
    const reopened = JSON.parse(
      fs.readFileSync(path.join(directory, "state.json")),
    );
    assert.equal(reopened.settings.concurrency, 1);
    assert.equal(reopened.settings.windowBounds.width, 1100);
  },
);
