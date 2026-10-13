// Where data, settings and backups live. Shared by every server module and scripts/.
// DATA_DIR comes from the environment (the Windows package sets it next to its launcher):
//   DATA_DIR/accounts.json          users and factories (store.js)
//   DATA_DIR/factories/<id>.json    one data file per factory
//   DATA_DIR/settings.json          backup folder/retention, session signing secret
//   DATA_DIR/db.json                legacy single-factory file, migrated on first start
// The backup folder and retention can be changed in Settings; those choices take precedence
// over the BACKUP_DIR / BACKUP_KEEP_DAYS env vars.
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const LEGACY_DATA_FILE = path.join(DATA_DIR, "db.json");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const FACTORIES_DIR = path.join(DATA_DIR, "factories");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const DEFAULT_BACKUP_DIR = path.join(path.dirname(DATA_DIR), "backups");

// Write to a temp file and rename over the real one, so a crash mid-write never leaves a half file.
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch { return {}; }
}
function writeSettings(settings) {
  writeJsonAtomic(SETTINGS_FILE, settings);
}

// Effective backup folder and retention, plus where each value came from (shown in Settings).
function backupConfig() {
  const s = readSettings();
  const dir = s.backupDir || process.env.BACKUP_DIR || DEFAULT_BACKUP_DIR;
  const source = s.backupDir ? "settings" : process.env.BACKUP_DIR ? "environment" : "default";
  const keepDays = Math.max(1, Number(s.backupKeepDays) || Number(process.env.BACKUP_KEEP_DAYS) || 30);
  return { dir: path.resolve(dir), source, keepDays };
}

// Local (not UTC) date/time, so backup names match the calendar day the user sees.
function localStamp(date = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return {
    day: `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`,
    time: `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  };
}

module.exports = {
  DATA_DIR, LEGACY_DATA_FILE, ACCOUNTS_FILE, FACTORIES_DIR, SETTINGS_FILE, DEFAULT_BACKUP_DIR,
  writeJsonAtomic, readSettings, writeSettings, backupConfig, localStamp
};
