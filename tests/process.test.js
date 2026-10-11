const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { runProcess } = require("../src/main/process");

test(
  "aborting a Windows tool stops its descendants before its workspace can be reused",
  { skip: process.platform !== "win32" },
  async (t) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "tubedeck-process-"),
    );
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const marker = path.join(directory, "writing.txt");
    const writer =
      "const fs=require('fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),20);";
    const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)},process.argv[1]],{stdio:'inherit'});setInterval(()=>{},1000);`;
    const controller = new AbortController();
    const pending = runProcess(process.execPath, ["-e", parent, marker], {
      signal: controller.signal,
    });
    const rejection = assert.rejects(pending, /Canceled by test/);
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(marker)) {
      if (Date.now() > deadline) {
        controller.abort(new Error("Canceled by test"));
        throw new Error("The worker did not start");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort(new Error("Canceled by test"));
    await rejection;
    const size = fs.statSync(marker).size;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.statSync(marker).size, size);
  },
);
