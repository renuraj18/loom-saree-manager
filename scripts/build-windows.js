// Builds a portable Windows package: dist/MyThari-windows.zip
// Unzip anywhere on a Windows PC and double-click "Start My Thari". No install needed:
// the official Windows Node.js runtime is bundled inside. Run on macOS/Linux (uses unzip + zip).
//
//   npm run build:win
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const NODE_VERSION = "22.14.0";
const NODE_ZIP = `node-v${NODE_VERSION}-win-x64.zip`;
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ZIP}`;
const SUMS_URL = `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`;

const ROOT = path.join(__dirname, "..");
const CACHE = path.join(ROOT, ".cache");
const DIST = path.join(ROOT, "dist");
const PKG = path.join(DIST, "MyThari");
const APP = path.join(PKG, "app");

// Windows batch/text files need CRLF line endings.
const crlf = s => s.replace(/\r?\n/g, "\r\n");

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function nodeRuntime() {
  fs.mkdirSync(CACHE, { recursive: true });
  const zip = path.join(CACHE, NODE_ZIP);
  if (!fs.existsSync(zip)) {
    console.log(`Downloading ${NODE_URL}`);
    await download(NODE_URL, zip);
  }
  const sums = await (await fetch(SUMS_URL)).text();
  const expected = sums.split("\n").find(l => l.endsWith(`  ${NODE_ZIP}`))?.split(" ")[0];
  const actual = crypto.createHash("sha256").update(fs.readFileSync(zip)).digest("hex");
  if (!expected || expected !== actual) {
    fs.unlinkSync(zip);
    throw new Error(`Checksum mismatch for ${NODE_ZIP}; deleted it, please run again.`);
  }
  console.log(`Verified ${NODE_ZIP} (sha256 ${actual.slice(0, 12)}…)`);
  return zip;
}

const SETTINGS_BAT = `@rem ============================================================
@rem  My Thari settings
@rem  Open with Notepad (right-click > Edit), change, save, then restart the app.
@rem ============================================================

@rem Folder that holds the app data (db.json).
set "DATA_DIR=%~dp0data"

@rem Folder for automatic daily backups. Settings in the app can also change
@rem this, and its choice takes priority. To keep backups on another disk,
@rem a USB drive or a Google Drive / OneDrive folder, change it, for example:
@rem   set "BACKUP_DIR=D:\\LoomBackups"
set "BACKUP_DIR=%~dp0backups"

@rem How many days of daily backups to keep.
set "BACKUP_KEEP_DAYS=30"

@rem Port the app runs on. Change only if 3000 is used by another program.
set "PORT=3000"
`;

const START_BAT = `@echo off
title My Thari
cd /d "%~dp0"
call "%~dp0settings.bat"
set "OPEN_BROWSER=1"
echo.
echo   My Thari - Track all my loom production
echo   ----------------------------------------
echo   Keep this window open while you use the app. Close it to stop the app.
echo   Other devices on the same Wi-Fi can open  http://THIS-PC-IP:%PORT%
echo.
"%~dp0app\\node\\node.exe" "%~dp0app\\launcher.js"
if errorlevel 1 (
  echo.
  echo   The app stopped because of an error. See the message above.
  pause
)
`;

const RESET_BAT = `@echo off
title Reset My Thari data
cd /d "%~dp0"
call "%~dp0settings.bat"
"%~dp0app\\node\\node.exe" "%~dp0app\\scripts\\reset-data.js"
echo.
pause
`;

const SHORTCUT_BAT = `@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\\My Thari.lnk'); $s.TargetPath='%~dp0Start My Thari.bat'; $s.WorkingDirectory='%~dp0'; $s.IconLocation='%~dp0app\\public\\img\\thari.ico'; $s.Save()"
if errorlevel 1 (echo Could not create the shortcut.) else (echo A "My Thari" shortcut was added to your Desktop.)
pause
`;

const README = `MY THARI - TRACK ALL MY LOOM PRODUCTION (WINDOWS)
==================================================

START
  Double-click "Start My Thari". The app opens in your browser.
  Keep the black window open while you use the app; close it to stop the app.
  One-click from the Desktop: double-click "Create desktop shortcut" once.

  The first time, Windows Firewall may ask about Node.js. Click "Allow" (Private
  networks) if you want to open the app from your phone on the same Wi-Fi:
  http://<this PC's IP address>:3000   (find the IP with: ipconfig)

YOUR DATA
  data\\accounts.json          Users and factories.
  data\\factories\\*.json      One file per factory: warps, looms, deliveries,
                               stock and parties.

SIGN IN, FACTORIES AND USERS
  Everyone signs in. First login: admin / admin  - change it right away
  (top right menu > Change password).
  The factory picker at the top left switches between factories.
  Admins: top right menu > Settings to add factories (name, location, owner)
  and users, choose which factories each user can open, manage backups,
  change the backup folder and restart the app.
  Users only see their factories and cannot discard warps or remove looms.

BACKUPS (automatic)
  backups\\db-YYYY-MM-DD.json   One file per day, refreshed every hour while the
                               app runs. The last 30 days are kept.
  To back up to another disk / USB / Google Drive folder: edit settings.bat
  (right-click > Edit) and change BACKUP_DIR. Then restart the app.
  Manual backup any time: the "Download backup" link at the bottom of the app.

RESTORE A BACKUP
  Settings > Backups > Restore. Each backup holds every factory. Restoring
  brings factories and their data back to that point; user logins are kept.
  Everything is backed up first, so a restore can be undone.

RESET (empty all factories)
  Double-click "Reset data" and type RESET. Every factory's data is cleared;
  factories and users stay. A full backup is saved first as
  db-before-reset-<date>-<time>.json and can be restored from Settings.

UPDATING THE APP
  Replace only the "app" folder with the new version. Keep data, backups and
  settings.bat.
`;

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true, filter: s => !/[\\/]\.DS_Store$/.test(s) });
}

(async () => {
  const zip = await nodeRuntime();
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(APP, "node"), { recursive: true });

  for (const f of ["launcher.js", "server.js", "auth.js", "store.js", "admin.js", "backup.js", "paths.js", "upgrade.js", "package.json", "package-lock.json"]) {
    if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(APP, f));
  }
  // Settings → App → Upgrade compares this commit with the latest release on GitHub.
  // BUILD_NUMBER is set by the GitHub Actions release workflow; dist/version.json is uploaded
  // next to the zip so the app can check a release without downloading it.
  try {
    const [commit, date, ...msg] = execFileSync("git", ["log", "-1", "--format=%H%n%cI%n%s"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n");
    const version = { version: require(path.join(ROOT, "package.json")).version, build: process.env.BUILD_NUMBER ? Number(process.env.BUILD_NUMBER) : null, commit, date, message: msg.join(" "), builtAt: new Date().toISOString() };
    fs.writeFileSync(path.join(APP, "VERSION.json"), JSON.stringify(version, null, 2));
    fs.writeFileSync(path.join(DIST, "version.json"), JSON.stringify(version, null, 2));
  } catch { console.warn("Not a git checkout: VERSION.json not written, so the first upgrade always installs the latest."); }
  copyDir(path.join(ROOT, "public"), path.join(APP, "public"));
  fs.mkdirSync(path.join(APP, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "scripts", "reset-data.js"), path.join(APP, "scripts", "reset-data.js"));
  // Runtime dependencies are pure JavaScript, so the local node_modules work on Windows as-is.
  for (const dep of Object.keys(require(path.join(ROOT, "package.json")).dependencies)) {
    if (!fs.existsSync(path.join(ROOT, "node_modules", dep))) throw new Error(`Run "npm install" first (missing ${dep}).`);
  }
  copyDir(path.join(ROOT, "node_modules"), path.join(APP, "node_modules"));
  fs.rmSync(path.join(APP, "node_modules", ".bin"), { recursive: true, force: true });

  execFileSync("unzip", ["-q", "-j", zip, `node-v${NODE_VERSION}-win-x64/node.exe`, "-d", path.join(APP, "node")]);
  execFileSync("unzip", ["-q", "-j", zip, `node-v${NODE_VERSION}-win-x64/LICENSE`, "-d", path.join(APP, "node")]);

  fs.writeFileSync(path.join(PKG, "settings.bat"), crlf(SETTINGS_BAT));
  fs.writeFileSync(path.join(PKG, "Start My Thari.bat"), crlf(START_BAT));
  fs.writeFileSync(path.join(PKG, "Reset data.bat"), crlf(RESET_BAT));
  fs.writeFileSync(path.join(PKG, "Create desktop shortcut.bat"), crlf(SHORTCUT_BAT));
  fs.writeFileSync(path.join(PKG, "README.txt"), crlf(README));

  const out = path.join(DIST, "MyThari-windows.zip");
  execFileSync("zip", ["-q", "-r", "-X", path.basename(out), path.basename(PKG)], { cwd: DIST });
  console.log(`Built ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
})().catch(err => { console.error(err.message); process.exit(1); });
