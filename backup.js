// Backup files cover the whole system: every factory's metadata and data in one JSON file
// ({ format: "loom-saree-backup", version: 2, factories, data: { <factoryId>: {...} } }).
// The format id predates the "My Thari" name; keep it so existing backup files still restore.
// User accounts are deliberately not included, so restoring never changes logins.
//   daily:    db-YYYY-MM-DD.json, refreshed hourly, pruned after keepDays
//   snapshot: db-<label>-YYYY-MM-DD-HHMMSS.json (manual, before-reset, before-restore,
//             before-delete-factory), never pruned
// Version 1 files (a single factory's { warps, looms, deliveries, ... }) from older releases
// can still be listed and restored into a chosen factory.
const fs = require("fs");
const path = require("path");
const { backupConfig, localStamp } = require("./paths");
const { readAccounts, readFactoryRaw, writeFactoryRaw } = require("./store");

const DAILY = /^db-\d{4}-\d{2}-\d{2}\.json$/;
// Only plain file names that look like our backups; blocks path tricks like "../x".
const BACKUP_NAME = /^db-[A-Za-z0-9-]+\.json$/;

function systemSnapshot() {
  const { factories } = readAccounts();
  const data = {};
  for (const f of factories) data[f.id] = readFactoryRaw(f.id);
  return { format: "loom-saree-backup", version: 2, createdAt: new Date().toISOString(), factories, data };
}

// Classifies parsed backup content: "system" (v2), "factory" (v1 single-factory data) or null.
function backupFormat(content) {
  if (content && content.format === "loom-saree-backup" && Array.isArray(content.factories) && content.data && typeof content.data === "object") return "system";
  if (content && typeof content === "object" && ["warps", "looms", "deliveries"].every(k => Array.isArray(content[k]))) return "factory";
  return null;
}

function writeBackup(file) {
  const { dir } = backupConfig();
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, file);
  const tmp = `${full}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(systemSnapshot(), null, 2));
  fs.renameSync(tmp, full);
  return full;
}

// Refreshes today's daily backup and prunes old dailies. Returns the file written, or null.
function backupNow() {
  try {
    const file = writeBackup(`db-${localStamp().day}.json`);
    const { dir, keepDays } = backupConfig();
    const daily = fs.readdirSync(dir).filter(f => DAILY.test(f)).sort();
    for (const old of daily.slice(0, Math.max(0, daily.length - keepDays))) fs.unlinkSync(path.join(dir, old));
    return file;
  } catch (err) {
    console.error("Backup failed:", err.message);
    return null;
  }
}

// Saves a timestamped backup that is never pruned. Returns its path.
function snapshot(label) {
  const { day, time } = localStamp();
  return writeBackup(`db-${label}-${day}-${time}.json`);
}

function kindOf(name) {
  if (DAILY.test(name)) return "daily";
  const m = name.match(/^db-([a-z-]+?)-\d{4}-\d{2}-\d{2}-\d{6}\.json$/);
  return m ? m[1] : "other";
}

function listBackups() {
  const { dir } = backupConfig();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => BACKUP_NAME.test(f))
    .map(name => {
      const st = fs.statSync(path.join(dir, name));
      return { name, kind: kindOf(name), size: st.size, modified: st.mtime.toISOString() };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

// Full path of an existing backup by file name, or null if the name is invalid or missing.
function backupPath(name) {
  if (typeof name !== "string" || !BACKUP_NAME.test(name)) return null;
  const file = path.join(backupConfig().dir, name);
  return fs.existsSync(file) ? file : null;
}

// ---- Activity log archives ----
// The Log page keeps the last LOG_KEEP_DAYS days. Older entries of every factory are moved to a
// CSV file in <backup folder>/logs/ (logs-YYYY-MM-DD-HHMMSS.csv), which opens in Excel.
const LOG_KEEP_DAYS = 30;
const LOG_NAME = /^logs-[A-Za-z0-9-]+\.csv$/;
const logDir = () => path.join(backupConfig().dir, "logs");
const csvCell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
function logTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const { day, time } = localStamp(d);
  return `${day} ${time.slice(0, 2)}:${time.slice(2, 4)}`;
}
// CSV of [{ factory, entry }], oldest first. The BOM makes Excel read it as UTF-8.
function logsCsv(rows) {
  const lines = [["Date", "Factory", "Type", "Activity", "By"].map(csvCell).join(",")];
  for (const { factory, entry } of [...rows].sort((a, b) => String(a.entry.at).localeCompare(String(b.entry.at)))) {
    lines.push([logTime(entry.at), factory, entry.type, entry.text, entry.by].map(csvCell).join(","));
  }
  return "\ufeff" + lines.join("\r\n") + "\r\n";
}
const cutoff = () => Date.now() - LOG_KEEP_DAYS * 24 * 60 * 60 * 1000;
const isOld = e => new Date(e.at).getTime() < cutoff();
// Per-factory log sizes for Settings.
function logStats() {
  return readAccounts().factories.map(f => {
    const log = readFactoryRaw(f.id).activity || [];
    return { id: f.id, name: f.name, total: log.length, old: log.filter(isOld).length };
  });
}
// Moves log entries older than LOG_KEEP_DAYS into a new CSV file, then removes them from the
// factory files. Returns { name, count } (name is null when nothing was old enough).
function archiveLogs() {
  const factories = readAccounts().factories;
  const rows = [], keep = {};
  for (const f of factories) {
    const data = readFactoryRaw(f.id);
    const log = data.activity || [];
    const old = log.filter(isOld);
    if (!old.length) continue;
    old.forEach(entry => rows.push({ factory: f.name, entry }));
    keep[f.id] = { data, log: log.filter(e => !isOld(e)) };
  }
  if (!rows.length) return { name: null, count: 0 };
  const { day, time } = localStamp();
  const name = `logs-${day}-${time}.csv`;
  fs.mkdirSync(logDir(), { recursive: true });
  const full = path.join(logDir(), name);
  fs.writeFileSync(`${full}.tmp`, logsCsv(rows));
  fs.renameSync(`${full}.tmp`, full);
  // Only after the archive is safely on disk are the entries removed from the app.
  for (const [id, { data, log }] of Object.entries(keep)) writeFactoryRaw(id, { ...data, activity: log });
  return { name, count: rows.length };
}
function safeArchiveLogs() {
  try { return archiveLogs(); } catch (err) { console.error("Log archive failed:", err.message); return null; }
}
// Every factory's current log as CSV (nothing is removed).
function currentLogsCsv() {
  const rows = [];
  for (const f of readAccounts().factories) for (const entry of readFactoryRaw(f.id).activity || []) rows.push({ factory: f.name, entry });
  return logsCsv(rows);
}
function listLogArchives() {
  if (!fs.existsSync(logDir())) return [];
  return fs.readdirSync(logDir()).filter(f => LOG_NAME.test(f)).map(name => {
    const st = fs.statSync(path.join(logDir(), name));
    return { name, size: st.size, modified: st.mtime.toISOString() };
  }).sort((a, b) => b.modified.localeCompare(a.modified));
}
function logArchivePath(name) {
  if (typeof name !== "string" || !LOG_NAME.test(name)) return null;
  const file = path.join(logDir(), name);
  return fs.existsSync(file) ? file : null;
}

module.exports = { systemSnapshot, backupFormat, backupNow, snapshot, listBackups, backupPath,
  LOG_KEEP_DAYS, logStats, archiveLogs, safeArchiveLogs, currentLogsCsv, listLogArchives, logArchivePath };
