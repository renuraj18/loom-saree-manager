// App version, status and self-upgrade from GitHub (Settings → App).
// Two kinds of install:
//   git      a git checkout (has .git): fetch + fast-forward merge, npm install if the
//            dependencies changed. Uses the computer's git login, or the saved GitHub token.
//   package  the Windows package (no git, no npm): downloads the branch tarball from the GitHub
//            API and replaces the app files. node_modules ship with the package, so an update
//            that needs different libraries is refused (install the new package instead).
//            The installed commit is kept in VERSION.json.
// Before changing anything a full data backup is taken (db-before-upgrade-…), and package
// installs also copy the files they replace to <backup folder>/app-before-upgrade-<stamp>/.
// The caller restarts the app (exit code 75) afterwards.
const fs = require("fs");
const path = require("path");
const https = require("https");
const zlib = require("zlib");
const { execFile } = require("child_process");
const { DATA_DIR, backupConfig, localStamp, readSettings, writeSettings } = require("./paths");

const ROOT = __dirname;
const VERSION_FILE = path.join(ROOT, "VERSION.json");
const readPkg = () => JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
// "github:owner/repo" (or a github.com URL) in package.json "repository"; branch from "config.upgradeBranch".
function repoInfo() {
  const pkg = readPkg();
  const raw = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url || "";
  const m = raw.match(/(?:github:|github\.com[/:])([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  return { repo: m ? m[1] : null, branch: pkg.config?.upgradeBranch || "main" };
}
const isGit = () => fs.existsSync(path.join(ROOT, ".git"));
const token = () => readSettings().githubToken || "";

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: ROOT, timeout: 5 * 60 * 1000, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, ...opts },
      (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).trim().split("\n").slice(-3).join(" "))) : resolve(stdout.trim()));
  });
}
// git with the saved token (if any) as HTTPS basic auth, so a private repo works without a stored login.
function git(args) {
  const t = token();
  const auth = t ? ["-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${t}`).toString("base64")}`] : [];
  return run("git", [...auth, ...args]);
}

// ---- Version and status ----
async function versionInfo() {
  const info = { version: readPkg().version, mode: isGit() ? "git" : "package", ...repoInfo(), commit: null, date: null, message: null };
  try {
    if (info.mode === "git") {
      const [commit, date, ...msg] = (await run("git", ["log", "-1", "--format=%H%n%cI%n%s"])).split("\n");
      Object.assign(info, { commit, date, message: msg.join(" ") });
    } else if (fs.existsSync(VERSION_FILE)) {
      const v = JSON.parse(fs.readFileSync(VERSION_FILE, "utf8"));
      Object.assign(info, { commit: v.commit || null, date: v.date || null, message: v.message || null, installedAt: v.installedAt || null });
    }
  } catch { /* version details are optional */ }
  return info;
}
function dirSize(dir, skip = () => false) {
  let bytes = 0, files = 0;
  if (!fs.existsSync(dir)) return { bytes, files };
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (skip(full)) continue;
    if (e.isDirectory()) { const s = dirSize(full, skip); bytes += s.bytes; files += s.files; }
    else if (e.isFile()) { bytes += fs.statSync(full).size; files++; }
  }
  return { bytes, files };
}
function appStatus(activeLogEntries) {
  const { dir } = backupConfig();
  const logs = path.join(dir, "logs");
  return {
    dataDir: DATA_DIR, data: dirSize(DATA_DIR), factoriesData: dirSize(path.join(DATA_DIR, "factories")),
    backupDir: dir, backups: dirSize(dir, f => f === logs || path.basename(f).startsWith("app-before-upgrade-")),
    logArchives: dirSize(logs), activeLogEntries,
    node: process.version, platform: `${process.platform} ${process.arch}`, uptimeSec: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1048576), hasToken: !!token()
  };
}
function saveToken(value) {
  const s = readSettings();
  if (value) s.githubToken = value; else delete s.githubToken;
  writeSettings(s);
}

// ---- GitHub API (package installs) ----
function httpsGet(url, headers = {}, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "my-thari-upgrade", ...headers } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url);
        // The redirect target carries its own short-lived access; never send the token to another host.
        const h = next.host === new URL(url).host ? headers : {};
        return resolve(httpsGet(next.href, h, redirects - 1));
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.setTimeout(60000, () => req.destroy(new Error("GitHub did not answer in time.")));
  });
}
function apiHeaders() {
  const t = token();
  return { Accept: "application/vnd.github+json", ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}
async function latestFromApi() {
  const { repo, branch } = repoInfo();
  if (!repo) throw new Error("No GitHub repository is set in package.json.");
  const r = await httpsGet(`https://api.github.com/repos/${repo}/commits/${branch}`, apiHeaders());
  if (r.status === 404 || r.status === 401) throw new Error(token() ? "GitHub refused the token, or the repository was not found. Check the token's access." : "The repository is private or was not found. Save a GitHub token below.");
  if (r.status !== 200) throw new Error(`GitHub answered ${r.status}.`);
  const c = JSON.parse(r.body.toString("utf8"));
  return { commit: c.sha, date: c.commit?.committer?.date || null, message: (c.commit?.message || "").split("\n")[0] };
}

// ---- Check ----
async function checkUpdate() {
  const current = await versionInfo();
  if (current.mode === "git") {
    const { branch } = repoInfo();
    await git(["fetch", "--quiet", "origin", branch]);
    const behind = Number(await run("git", ["rev-list", "--count", `HEAD..origin/${branch}`]));
    const [commit, date, ...msg] = (await run("git", ["log", "-1", "--format=%H%n%cI%n%s", `origin/${branch}`])).split("\n");
    return { current, latest: { commit, date, message: msg.join(" ") }, behind, upToDate: behind === 0 };
  }
  const latest = await latestFromApi();
  return { current, latest, behind: null, upToDate: !!current.commit && current.commit === latest.commit };
}

// ---- Upgrade ----
let busy = false;
async function upgrade(takeBackup) {
  if (busy) throw new Error("An upgrade is already running.");
  busy = true;
  const steps = [];
  try {
    const result = isGit() ? await upgradeGit(takeBackup, steps) : await upgradePackage(takeBackup, steps);
    return { ...result, steps };
  } finally { busy = false; }
}

async function upgradeGit(takeBackup, steps) {
  const { branch } = repoInfo();
  if (await run("git", ["status", "--porcelain", "--untracked-files=no"])) {
    throw new Error("This copy has local code changes that are not committed. Commit or discard them before upgrading.");
  }
  await git(["fetch", "--quiet", "origin", branch]);
  const behind = Number(await run("git", ["rev-list", "--count", `HEAD..origin/${branch}`]));
  if (!behind) return { upToDate: true };
  const from = await run("git", ["rev-parse", "HEAD"]);
  steps.push(`Backup saved: ${takeBackup()}`);
  try {
    await run("git", ["merge", "--ff-only", `origin/${branch}`]);
  } catch (err) {
    throw new Error(`Could not fast-forward to the latest version (${err.message}). Nothing was changed.`);
  }
  const to = await run("git", ["rev-parse", "HEAD"]);
  steps.push(`Updated ${from.slice(0, 7)} → ${to.slice(0, 7)} (${behind} change${behind === 1 ? "" : "s"})`);
  try {
    const changed = (await run("git", ["diff", "--name-only", from, to])).split("\n");
    if (changed.some(f => f === "package.json" || f === "package-lock.json")) {
      await run(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--omit=dev"], { shell: process.platform === "win32" });
      steps.push("Libraries updated (npm install)");
    }
    await checkSyntax(ROOT);
  } catch (err) {
    await run("git", ["reset", "--hard", from]);
    throw new Error(`The new version failed to install (${err.message}). Rolled back to ${from.slice(0, 7)}.`);
  }
  return { from, to };
}

// Files a package update replaces (relative to the app folder). node/ and node_modules/ stay.
const APP_ITEMS = dir => [
  ...fs.readdirSync(dir).filter(f => f.endsWith(".js")),
  "package.json", "package-lock.json", "public", "scripts"
].filter(f => fs.existsSync(path.join(dir, f)));

async function upgradePackage(takeBackup, steps) {
  const { repo, branch } = repoInfo();
  const current = await versionInfo();
  const latest = await latestFromApi();
  if (current.commit && current.commit === latest.commit) return { upToDate: true };

  const r = await httpsGet(`https://api.github.com/repos/${repo}/tarball/${latest.commit}`, apiHeaders());
  if (r.status !== 200) throw new Error(`Could not download the update (GitHub answered ${r.status}).`);
  const stage = path.join(DATA_DIR, ".upgrade");
  fs.rmSync(stage, { recursive: true, force: true });
  extractTarball(zlib.gunzipSync(r.body), stage);
  steps.push(`Downloaded ${latest.commit.slice(0, 7)}`);

  for (const f of ["server.js", "launcher.js", "package.json", path.join("public", "index.html")]) {
    if (!fs.existsSync(path.join(stage, f))) throw new Error(`The download is missing ${f}. Nothing was changed.`);
  }
  await checkSyntax(stage);
  const missing = missingDeps(JSON.parse(fs.readFileSync(path.join(stage, "package.json"), "utf8")));
  if (missing.length) throw new Error(`This update needs new libraries (${missing.join(", ")}). Install the new Windows package instead. Nothing was changed.`);

  steps.push(`Backup saved: ${takeBackup()}`);
  const { day, time } = localStamp();
  const keep = path.join(backupConfig().dir, `app-before-upgrade-${day}-${time}`);
  const old = APP_ITEMS(ROOT);
  fs.mkdirSync(keep, { recursive: true });
  for (const f of [...old, "VERSION.json"]) if (fs.existsSync(path.join(ROOT, f))) fs.cpSync(path.join(ROOT, f), path.join(keep, f), { recursive: true });
  steps.push(`Current app files copied to ${keep}`);
  try {
    for (const f of APP_ITEMS(stage)) {
      const dest = path.join(ROOT, f);
      if (fs.statSync(path.join(stage, f)).isDirectory()) fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(path.join(stage, f), dest, { recursive: true });
    }
    fs.writeFileSync(VERSION_FILE, JSON.stringify({ version: readPkg().version, ...latest, installedAt: new Date().toISOString() }, null, 2));
  } catch (err) {
    for (const f of old) fs.cpSync(path.join(keep, f), path.join(ROOT, f), { recursive: true, force: true });
    if (fs.existsSync(path.join(keep, "VERSION.json"))) fs.copyFileSync(path.join(keep, "VERSION.json"), VERSION_FILE);
    throw new Error(`Could not replace the app files (${err.message}). The previous files were put back.`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  steps.push(`Updated ${current.commit ? current.commit.slice(0, 7) : "unknown"} → ${latest.commit.slice(0, 7)}`);
  return { from: current.commit, to: latest.commit };
}

// Every top-level .js file must at least parse with this Node before it replaces working code.
async function checkSyntax(dir) {
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".js"))) {
    try { await run(process.execPath, ["--check", path.join(dir, f)]); }
    catch (err) { throw new Error(`${f} does not load: ${err.message}`); }
  }
}
// Dependencies the bundled node_modules cannot satisfy (exact versions and ^ / ~ ranges).
function missingDeps(pkg) {
  const out = [];
  for (const [name, range] of Object.entries(pkg.dependencies || {})) {
    let have;
    try { have = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", name, "package.json"), "utf8")).version; } catch { out.push(name); continue; }
    if (!satisfies(have, range)) out.push(`${name}@${range}`);
  }
  return out;
}
function satisfies(version, range) {
  const v = version.split(".").map(Number), r = range.replace(/^[\^~=]/, "").split(".").map(Number);
  if (range.startsWith("^")) return v[0] === r[0] && (v[1] > r[1] || (v[1] === r[1] && v[2] >= r[2]));
  if (range.startsWith("~")) return v[0] === r[0] && v[1] === r[1] && v[2] >= r[2];
  return /^\d+\.\d+\.\d+$/.test(range.replace(/^=/, "")) ? version === range.replace(/^=/, "") : true;
}

// Minimal tar reader for GitHub tarballs: regular files and directories, pax / GNU long names.
// The first path component (owner-repo-sha/) is dropped; anything escaping `dest` is skipped.
function extractTarball(buf, dest) {
  let off = 0, longName = null;
  const str = (a, b) => buf.toString("utf8", a, b).replace(/\0.*$/s, "");
  while (off + 512 <= buf.length) {
    const head = buf.subarray(off, off + 512);
    if (head.every(b => b === 0)) break;
    const size = parseInt(str(off + 124, off + 136).trim() || "0", 8);
    const type = String.fromCharCode(head[156] || 48);
    const prefix = str(off + 345, off + 500);
    let name = longName || (prefix ? `${prefix}/${str(off, off + 100)}` : str(off, off + 100));
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") { const m = body.toString("utf8").match(/\d+ path=([^\n]*)\n/); longName = m ? m[1] : null; continue; }
    if (type === "L") { longName = body.toString("utf8").replace(/\0.*$/s, ""); continue; }
    longName = null;
    if (type === "g") continue;
    const rel = name.split("/").slice(1).join("/");
    if (!rel) continue;
    const target = path.resolve(dest, rel);
    if (!target.startsWith(path.resolve(dest) + path.sep)) continue;
    if (type === "5") fs.mkdirSync(target, { recursive: true });
    else if (type === "0" || type === "\0" || type === "7") { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, body); }
  }
}

module.exports = { versionInfo, appStatus, checkUpdate, upgrade, saveToken, extractTarball };
