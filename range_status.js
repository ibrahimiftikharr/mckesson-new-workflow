/*
  Range status monitor for enrichment runs.

  Reads per-range log files such as:
    logs_1_5000.log
    logs_5001_10000.log

  Optionally cross-checks PM2 process state (if pm2 is installed/running).

  Usage:
    node range_status.js

  Optional env vars:
    LOG_PREFIX=logs_
    LOG_SUFFIX=.log
    RESULTS_PREFIX=results_
    RESULTS_SUFFIX=.jsonl
    ACTIVE_WINDOW_MINUTES=15
    OUTPUT_JSON=status_report.json
*/

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execSync } = require("child_process");

const LOG_PREFIX = process.env.LOG_PREFIX || "logs_";
const LOG_SUFFIX = process.env.LOG_SUFFIX || ".log";
const RESULTS_PREFIX = process.env.RESULTS_PREFIX || "results_";
const RESULTS_SUFFIX = process.env.RESULTS_SUFFIX || ".jsonl";
const ACTIVE_WINDOW_MINUTES = Number(process.env.ACTIVE_WINDOW_MINUTES || 15);
const OUTPUT_JSON = process.env.OUTPUT_JSON || "status_report.json";

function parseRangeFromFilename(fileName, prefix, suffix) {
  if (!fileName.startsWith(prefix) || !fileName.endsWith(suffix)) return null;

  const core = fileName.slice(prefix.length, fileName.length - suffix.length);
  const m = core.match(/^(\d+)_(\d+|end)$/i);
  if (!m) return null;

  const start = Number(m[1]);
  const end = m[2].toLowerCase() === "end" ? 0 : Number(m[2]);

  if (!Number.isInteger(start) || start < 1) return null;
  if (!Number.isInteger(end) || end < 0) return null;

  return {
    key: `${start}_${end || "end"}`,
    start,
    end,
  };
}

function tryGetPm2Map() {
  try {
    const raw = execSync("pm2 jlist", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const arr = JSON.parse(raw);
    const out = new Map();

    for (const proc of arr) {
      const env = proc.pm2_env || {};
      const args = Array.isArray(env.args)
        ? env.args
        : typeof env.args === "string"
          ? env.args.split(/\s+/).filter(Boolean)
          : [];

      const joined = args.join(" ");
      const startMatch = joined.match(/(?:--start_line\s+)(\d+)/);
      const endMatch = joined.match(/(?:--end_line\s+)(\d+)/);
      if (!startMatch || !endMatch) continue;

      const start = Number(startMatch[1]);
      const end = Number(endMatch[1]);
      const key = `${start}_${end || "end"}`;

      out.set(key, {
        name: proc.name || "",
        pm2Status: env.status || "unknown",
        pid: proc.pid || null,
      });
    }

    return out;
  } catch {
    return new Map();
  }
}

async function analyzeLogFile(filePath) {
  const byIndexLatest = new Map();
  let successCountRaw = 0;
  let failedCountRaw = 0;
  let lastTimestamp = null;

  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line || !line.trim()) continue;

    const parts = line.split("\t");
    if (parts.length < 4) continue;

    const timestampStr = parts[0];
    const idx = Number(parts[1]);
    const status = String(parts[3] || "").trim();

    const ts = Date.parse(timestampStr);
    if (Number.isFinite(ts)) {
      if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
    }

    if (status === "SUCCESS") successCountRaw += 1;
    if (status === "FAILED") failedCountRaw += 1;

    if (Number.isInteger(idx) && idx > 0) {
      byIndexLatest.set(idx, status);
    }
  }

  let done = 0;
  let failedUnique = 0;
  for (const status of byIndexLatest.values()) {
    if (status === "SUCCESS") done += 1;
    if (status === "FAILED") failedUnique += 1;
  }

  return {
    done,
    failedUnique,
    successCountRaw,
    failedCountRaw,
    lastTimestamp,
    lastTimestampIso: lastTimestamp ? new Date(lastTimestamp).toISOString() : null,
  };
}

async function countLines(filePath) {
  if (!fs.existsSync(filePath)) return 0;

  let count = 0;
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    if (line && line.trim()) count += 1;
  }

  return count;
}

function minutesSince(timestampMs) {
  if (!timestampMs) return null;
  return (Date.now() - timestampMs) / 60000;
}

async function main() {
  const cwd = process.cwd();
  const names = fs.readdirSync(cwd);

  const rangeMap = new Map();

  for (const name of names) {
    const parsedLog = parseRangeFromFilename(name, LOG_PREFIX, LOG_SUFFIX);
    if (parsedLog) {
      const row = rangeMap.get(parsedLog.key) || { ...parsedLog };
      row.logFile = name;
      rangeMap.set(parsedLog.key, row);
    }

    const parsedResult = parseRangeFromFilename(name, RESULTS_PREFIX, RESULTS_SUFFIX);
    if (parsedResult) {
      const row = rangeMap.get(parsedResult.key) || { ...parsedResult };
      row.resultFile = name;
      rangeMap.set(parsedResult.key, row);
    }
  }

  const pm2Map = tryGetPm2Map();
  const items = [];

  for (const row of rangeMap.values()) {
    const totalInRange = row.end > 0 ? (row.end - row.start + 1) : null;

    let doneFromLog = 0;
    let failedUnique = 0;
    let failedRaw = 0;
    let lastTimestamp = null;
    let lastTimestampIso = null;

    if (row.logFile) {
      const analyzed = await analyzeLogFile(path.join(cwd, row.logFile));
      doneFromLog = analyzed.done;
      failedUnique = analyzed.failedUnique;
      failedRaw = analyzed.failedCountRaw;
      lastTimestamp = analyzed.lastTimestamp;
      lastTimestampIso = analyzed.lastTimestampIso;
    }

    let doneFromResults = 0;
    if (row.resultFile) {
      doneFromResults = await countLines(path.join(cwd, row.resultFile));
    }

    const done = Math.max(doneFromLog, doneFromResults);
    const remaining = totalInRange == null ? null : Math.max(totalInRange - done, 0);

    const pm2 = pm2Map.get(row.key) || null;
    const pm2Online = pm2 ? pm2.pm2Status === "online" : false;

    const mins = minutesSince(lastTimestamp);
    const recentActivity = mins != null && mins <= ACTIVE_WINDOW_MINUTES;
    const completed = totalInRange != null ? done >= totalInRange : false;

    const active = pm2Online || (recentActivity && !completed);
    const workingCorrect = failedUnique === 0 && (completed || active || done > 0);

    let state = "unknown";
    if (completed) state = "completed";
    else if (active && failedUnique === 0) state = "running";
    else if (active && failedUnique > 0) state = "running_with_failures";
    else if (!active && done > 0 && !completed) state = "stalled_or_stopped";
    else if (!active && done === 0) state = "not_started";

    items.push({
      rangeStart: row.start,
      rangeEnd: row.end,
      rangeKey: row.key,
      totalInRange,
      done,
      remaining,
      failedUnique,
      failedRaw,
      active,
      workingCorrect,
      state,
      lastLogUpdate: lastTimestampIso,
      pm2Name: pm2 ? pm2.name : null,
      pm2Status: pm2 ? pm2.pm2Status : "not_detected",
      logFile: row.logFile || null,
      resultFile: row.resultFile || null,
    });
  }

  items.sort((a, b) => a.rangeStart - b.rangeStart);

  const totals = items.reduce(
    (acc, x) => {
      acc.ranges += 1;
      acc.done += x.done || 0;
      acc.failedUnique += x.failedUnique || 0;
      if (x.remaining != null) acc.remaining += x.remaining;
      if (x.active) acc.activeRanges += 1;
      return acc;
    },
    { ranges: 0, done: 0, remaining: 0, failedUnique: 0, activeRanges: 0 }
  );

  const report = {
    generatedAt: new Date().toISOString(),
    activeWindowMinutes: ACTIVE_WINDOW_MINUTES,
    totals,
    ranges: items,
  };

  fs.writeFileSync(path.join(cwd, OUTPUT_JSON), JSON.stringify(report, null, 2), "utf8");

  console.log(`Wrote ${OUTPUT_JSON}`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error("Fatal error:", err && err.message ? err.message : err);
  process.exit(1);
});
