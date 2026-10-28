// Test helpers: start the real server on a free port with a throwaway data folder, and a tiny API client.
// Run with `npm test` (Node's built-in test runner, no extra dependencies).
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on("error", reject);
  });
}

// Starts server.js against an empty data dir. Returns { url, dir, stop, api, admin }.
// seed(dirs) can write files (an old db.json, a backup file…) before the server starts: dirs = { data, backups }.
async function startApp({ seed } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thari-test-"));
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.mkdirSync(path.join(dir, "backups"), { recursive: true });
  if (seed) seed({ data: path.join(dir, "data"), backups: path.join(dir, "backups") });
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: path.join(dir, "data"), BACKUP_DIR: path.join(dir, "backups"), OPEN_BROWSER: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  child.stderr.on("data", d => { log += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start:\n" + log)), 15000);
    child.stdout.on("data", d => { log += d; if (/running on/.test(String(d))) { clearTimeout(t); resolve(); } });
    child.on("exit", code => { clearTimeout(t); reject(new Error(`server exited (${code}):\n${log}`)); });
  });
  const url = `http://127.0.0.1:${port}`;

  // api(token, factoryId) -> { get, post, put, del } returning { status, body }.
  const api = (token, factoryId) => {
    const call = async (method, p, body) => {
      const headers = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (factoryId) headers["X-Factory"] = factoryId;
      const r = await fetch(url + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json; try { json = JSON.parse(text); } catch { json = text; }
      return { status: r.status, body: json };
    };
    return { get: p => call("GET", p), post: (p, b = {}) => call("POST", p, b), put: (p, b = {}) => call("PUT", p, b), del: (p, b) => call("DELETE", p, b) };
  };

  const login = async (username, password) => {
    const r = await api().post("/api/auth/login", { username, password });
    if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const first = await login("admin", "admin");
  const factoryId = first.factories[0].id;
  // admin: API for the default factory with the admin token; raw: no factory header (admin/auth routes).
  const admin = api(first.token, factoryId);
  const adminRaw = api(first.token);

  // A new factory (with its own data) for a test that needs specific modules / wage settings.
  const newFactory = async (extra = {}, name = `Factory ${Math.random().toString(36).slice(2, 7)}`) => {
    const r = await adminRaw.post("/api/admin/factories", { name, location: "Test", ownerName: "Owner", ...extra });
    if (r.status !== 201) throw new Error(`factory create failed: ${JSON.stringify(r.body)}`);
    return { id: r.body.id, factory: r.body, api: api(first.token, r.body.id) };
  };

  const stop = () => new Promise(resolve => {
    child.once("exit", () => { fs.rmSync(dir, { recursive: true, force: true }); resolve(); });
    child.kill();
  });
  return { url, dir, stop, api, login, admin, adminRaw, token: first.token, factoryId, newFactory };
}

// Seeds: a running loom (with a warp) and returns ids. widthType single by default.
async function runningLoom(a, { name = "L1", warpName = "W1", meters = 200, widthType = "single", needsBobbin = false } = {}) {
  const warp = (await a.post("/api/warps", { name: warpName, widthType, meters, bodyColor: "Red", borderColor: "Gold" })).body;
  const loom = (await a.post("/api/looms", { name, widthType, needsBobbin })).body;
  await a.post(`/api/warps/${warp.id}/move`, { to: "ready" });
  const r = await a.post(`/api/warps/${warp.id}/move`, { to: "running", loomId: loom.id });
  if (r.status !== 200) throw new Error(`could not put warp on loom: ${JSON.stringify(r.body)}`);
  return { warp, loom };
}
const dispatch = (a, loomId, sarees, extra = {}) => a.post("/api/deliveries", { loomId, sarees, ...extra });
const dataOf = async a => (await a.get("/api/data")).body;

module.exports = { startApp, runningLoom, dispatch, dataOf, ROOT };
