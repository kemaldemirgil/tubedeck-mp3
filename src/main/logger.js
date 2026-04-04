const fs = require("fs");
const path = require("path");
const log = require("electron-log/main");

const RECENT_LOG_LIMIT = 200;

const createLogger = (app) => {
  const logDirectory = path.join(app.getPath("userData"), "logs");
  const eventLogPath = path.join(logDirectory, "events.jsonl");
  const recentEntries = [];

  fs.mkdirSync(logDirectory, { recursive: true });

  log.initialize();
  log.transports.file.resolvePathFn = () => path.join(logDirectory, "app.log");
  log.transports.file.level = "info";
  log.transports.console.level = false;

  const hydrateRecentEntries = () => {
    // The renderer only needs the recent tail, so avoid loading the full history into memory.
    if (!fs.existsSync(eventLogPath)) {
      return;
    }

    const lines = fs
      .readFileSync(eventLogPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-RECENT_LOG_LIMIT);

    recentEntries.splice(0, recentEntries.length);
    lines.forEach((line) => {
      try {
        recentEntries.push(JSON.parse(line));
      } catch (_error) {
        // Ignore malformed historical log lines and keep the logger usable.
      }
    });
  };

  hydrateRecentEntries();

  const writeEntry = (level, event, metadata = {}) => {
    // JSONL makes support exports and manual inspection simpler than storing one large JSON blob.
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      level,
      event,
      metadata
    };

    recentEntries.push(entry);
    if (recentEntries.length > RECENT_LOG_LIMIT) {
      recentEntries.shift();
    }

    fs.appendFileSync(eventLogPath, `${JSON.stringify(entry)}\n`);
    log[level](`${event} ${JSON.stringify(metadata)}`);

    return entry;
  };

  return {
    getLogDirectory: () => logDirectory,
    readRecent: () => recentEntries.slice().reverse(),
    info: (event, metadata) => writeEntry("info", event, metadata),
    warn: (event, metadata) => writeEntry("warn", event, metadata),
    error: (event, metadata) => writeEntry("error", event, metadata)
  };
};

module.exports = {
  createLogger
};
