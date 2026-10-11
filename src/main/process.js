const { execFile } = require("child_process");

const stopping = new WeakMap();
const stopProcessTree = (child) => {
  if (!child) return Promise.resolve();
  if (stopping.has(child)) return stopping.get(child);
  // Register the wait before killing: small processes and test doubles may close immediately.
  const stopped = Promise.resolve().then(
    () =>
      new Promise((resolve) => {
        if (process.platform === "win32" && child.pid)
          execFile(
            "taskkill",
            ["/pid", String(child.pid), "/T", "/F"],
            { windowsHide: true },
            (error) => {
              if (error) child.kill?.("SIGTERM");
              resolve();
            },
          );
        else {
          child.kill?.("SIGTERM");
          resolve();
        }
      }),
  );
  stopping.set(child, stopped);
  return stopped;
};
const waitForProcessStop = (child) => stopping.get(child);
const waitWithSignal = (pending, signal) => {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(pending).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
};
const runProcess = (binary, args, options = {}) =>
  new Promise((resolve, reject) => {
    const { signal, timeout = 120000, ...execOptions } = options;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let interruption,
      timer,
      stopWait,
      finished = false;
    const stop = (reason) => {
      if (interruption) return;
      interruption = reason;
      stopWait = stopProcessTree(child);
    };
    const abort = () => stop(signal.reason);
    const child = execFile(
      binary,
      args,
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...execOptions },
      async (error, stdout, stderr) => {
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        await stopWait;
        if (interruption) reject(interruption);
        else if (error)
          reject(new Error(String(stderr || error.message).slice(-5000)));
        else resolve(stdout);
      },
    );
    if (finished) return;
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(
      () => stop(new Error("The tool timed out without finishing.")),
      timeout,
    );
    timer.unref?.();
  });

module.exports = {
  stopProcessTree,
  waitForProcessStop,
  waitWithSignal,
  runProcess,
};
