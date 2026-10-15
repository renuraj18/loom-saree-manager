// Settings API (mounted at /api/admin behind requireAuth + requireAdmin):
// factories, users, backups, backup location, export and restart.
const express = require("express");
const fs = require("fs");
const path = require("path");
const { backupConfig, readSettings, writeSettings } = require("./paths");
const store = require("./store");
const { systemSnapshot, backupFormat, backupNow, snapshot, listBackups, backupPath,
  LOG_KEEP_DAYS, logStats, archiveLogs, currentLogsCsv, listLogArchives, logArchivePath } = require("./backup");

const upgrader = require("./upgrade");

const STARTED_AT = new Date().toISOString();
// The launcher (launcher.js) restarts the server when it exits with this code.
const RESTART_EXIT_CODE = 75;
const text = v => (typeof v === "string" ? v.trim() : "");

// modules: which parts of the app this factory uses, { stock, wages }; at least one is on.
// Not sent (older pages): keep the factory's current setting.
function factoryFields(body) {
  const f = { name: text(body.name), location: text(body.location), ownerName: text(body.ownerName), ownerPhone: text(body.ownerPhone), ownerEmail: text(body.ownerEmail) };
  if (body.modules && typeof body.modules === "object") f.modules = { stock: body.modules.stock !== false, wages: body.modules.wages !== false };
  return f;
}
function factoryError(f, accounts, selfId) {
  if (!f.name || !f.location || !f.ownerName) return "Enter the factory name, location and owner name.";
  if (f.modules && !f.modules.stock && !f.modules.wages) return "Choose Stock, Wages or both for this factory.";
  if (accounts.factories.some(x => x.id !== selfId && x.name.toLowerCase() === f.name.toLowerCase())) return "A factory with this name already exists.";
  return null;
}
// Keeps only factory ids that exist; admins see every factory, so their list is not needed.
function cleanFactoryIds(ids, accounts, role) {
  if (role === "admin") return [];
  return [...new Set(Array.isArray(ids) ? ids : [])].filter(id => accounts.factories.some(f => f.id === id));
}
const otherAdmins = (accounts, id) => accounts.users.filter(u => u.role === "admin" && u.id !== id).length;

module.exports = function adminRouter() {
  const router = express.Router();

  router.get("/info", async (_req, res) => {
    const cfg = backupConfig();
    const accounts = store.readAccounts();
    const logFactories = logStats();
    res.json({
      app: await upgrader.versionInfo(),
      status: upgrader.appStatus(logFactories.reduce((s, f) => s + f.total, 0)),
      backupDir: cfg.dir, backupDirSource: cfg.source, keepDays: cfg.keepDays,
      startedAt: STARTED_AT, canRestart: process.env.LOOM_SUPERVISED === "1",
      backups: listBackups(),
      logs: { keepDays: LOG_KEEP_DAYS, dir: path.join(cfg.dir, "logs"), factories: logFactories, archives: listLogArchives() },
      factories: accounts.factories,
      users: accounts.users.map(store.publicUser)
    });
  });

  // ---- Factories ----
  router.post("/factories", (req, res) => {
    const accounts = store.readAccounts();
    const f = factoryFields(req.body || {});
    const err = factoryError(f, accounts);
    if (err) return res.status(400).json({ error: err });
    const factory = { id: store.newId("FAC"), ...f, createdAt: new Date().toISOString() };
    store.writeFactoryRaw(factory.id, store.emptyFactoryData());
    accounts.factories.push(factory);
    store.writeAccounts(accounts);
    res.status(201).json(factory);
  });

  router.put("/factories/:id", (req, res) => {
    const accounts = store.readAccounts();
    const factory = accounts.factories.find(f => f.id === req.params.id);
    if (!factory) return res.status(404).json({ error: "Factory not found." });
    const f = factoryFields(req.body || {});
    const err = factoryError(f, accounts, factory.id);
    if (err) return res.status(400).json({ error: err });
    Object.assign(factory, f);
    store.writeAccounts(accounts);
    res.json(factory);
  });

  // Reset wipes one factory's data (warps, looms, deliveries, stock, clients) but keeps the factory
  // and its users. Same confirmation as delete, and a full backup first.
  router.post("/factories/:id/reset", (req, res) => {
    const factory = store.readAccounts().factories.find(f => f.id === req.params.id);
    if (!factory) return res.status(404).json({ error: "Factory not found." });
    if (text(req.body?.confirmName) !== factory.name) return res.status(400).json({ error: "Type the factory name exactly to confirm." });
    const saved = snapshot("before-reset-factory");
    store.writeFactoryRaw(factory.id, store.emptyFactoryData());
    res.json({ reset: factory.id, savedAs: path.basename(saved) });
  });

  // Deleting a factory removes its data, so the caller must repeat the factory name and a
  // full backup is taken first.
  router.delete("/factories/:id", (req, res) => {
    const accounts = store.readAccounts();
    const factory = accounts.factories.find(f => f.id === req.params.id);
    if (!factory) return res.status(404).json({ error: "Factory not found." });
    if (text(req.body?.confirmName) !== factory.name) return res.status(400).json({ error: "Type the factory name exactly to confirm." });
    const saved = snapshot("before-delete-factory");
    accounts.factories = accounts.factories.filter(f => f.id !== factory.id);
    for (const u of accounts.users) u.factoryIds = (u.factoryIds || []).filter(id => id !== factory.id);
    store.writeAccounts(accounts);
    fs.rmSync(store.factoryFile(factory.id), { force: true });
    res.json({ deleted: factory.id, savedAs: path.basename(saved) });
  });

  // ---- Users ----
  router.post("/users", (req, res) => {
    const b = req.body || {};
    const accounts = store.readAccounts();
    const username = text(b.username);
    const role = b.role === "admin" ? "admin" : "user";
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) return res.status(400).json({ error: "Username must be 3–32 letters, numbers, dots, dashes or underscores." });
    if (accounts.users.some(u => u.username.toLowerCase() === username.toLowerCase())) return res.status(409).json({ error: "That username is already taken." });
    if (String(b.password || "").length < 4) return res.status(400).json({ error: "Password must be at least 4 characters." });
    const user = {
      id: store.newId("USR"), username, name: text(b.name), role,
      factoryIds: cleanFactoryIds(b.factoryIds, accounts, role),
      ...store.hashPassword(b.password), tokenVersion: 0, createdAt: new Date().toISOString()
    };
    accounts.users.push(user);
    store.writeAccounts(accounts);
    res.status(201).json(store.publicUser(user));
  });

  router.put("/users/:id", (req, res) => {
    const b = req.body || {};
    const accounts = store.readAccounts();
    const user = accounts.users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "User not found." });
    const role = b.role === "admin" ? "admin" : "user";
    if (user.role === "admin" && role !== "admin" && !otherAdmins(accounts, user.id)) return res.status(400).json({ error: "There must be at least one admin." });
    if (user.id === req.user.id && role !== "admin") return res.status(400).json({ error: "You cannot remove your own admin role." });
    const username = text(b.username) || user.username;
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) return res.status(400).json({ error: "Username must be 3–32 letters, numbers, dots, dashes or underscores." });
    if (accounts.users.some(u => u.id !== user.id && u.username.toLowerCase() === username.toLowerCase())) return res.status(409).json({ error: "That username is already taken." });
    const password = String(b.password || "");
    if (password && password.length < 4) return res.status(400).json({ error: "Password must be at least 4 characters." });
    Object.assign(user, { username, name: text(b.name), role, factoryIds: cleanFactoryIds(b.factoryIds, accounts, role) });
    if (password) { Object.assign(user, store.hashPassword(password)); delete user.defaultPassword; }
    // Access changed: sign the user out so their next request picks up the new rights.
    // (Not for the admin editing their own name, which would sign them out of this page.)
    if (user.id !== req.user.id) user.tokenVersion = (user.tokenVersion || 0) + 1;
    store.writeAccounts(accounts);
    res.json(store.publicUser(user));
  });

  router.delete("/users/:id", (req, res) => {
    const accounts = store.readAccounts();
    const user = accounts.users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "User not found." });
    if (user.id === req.user.id) return res.status(400).json({ error: "You cannot delete your own account." });
    if (user.role === "admin" && !otherAdmins(accounts, user.id)) return res.status(400).json({ error: "There must be at least one admin." });
    accounts.users = accounts.users.filter(u => u.id !== user.id);
    store.writeAccounts(accounts);
    res.json({ deleted: user.id });
  });

  // ---- Backups ----
  router.post("/backup-now", (_req, res) => {
    backupNow();
    res.status(201).json({ name: path.basename(snapshot("manual")) });
  });

  router.get("/export", (_req, res) => {
    const { day } = require("./paths").localStamp();
    res.set("Content-Disposition", `attachment; filename="my-thari-backup-${day}.json"`);
    res.json(systemSnapshot());
  });

  // ---- Activity log backups ----
  router.post("/logs/archive", (_req, res) => {
    res.status(201).json(archiveLogs());
  });

  router.get("/logs-export", (_req, res) => {
    const { day } = require("./paths").localStamp();
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="my-thari-logs-${day}.csv"`);
    res.send(currentLogsCsv());
  });

  router.get("/logs/:name", (req, res) => {
    const file = logArchivePath(req.params.name);
    if (!file) return res.status(404).json({ error: "Log file not found." });
    res.download(file, req.params.name);
  });

  router.get("/backups/:name", (req, res) => {
    const file = backupPath(req.params.name);
    if (!file) return res.status(404).json({ error: "Backup not found." });
    res.download(file, req.params.name);
  });

  router.delete("/backups/:name", (req, res) => {
    const file = backupPath(req.params.name);
    if (!file) return res.status(404).json({ error: "Backup not found." });
    fs.unlinkSync(file);
    res.json({ deleted: req.params.name });
  });

  // System backups bring back every factory and its data; user accounts stay as they are
  // (assignments to factories that no longer exist are dropped). A single-factory backup from
  // the older version is restored into the factory given in body.factoryId.
  router.post("/backups/:name/restore", (req, res) => {
    const file = backupPath(req.params.name);
    if (!file) return res.status(404).json({ error: "Backup not found." });
    let content;
    try { content = JSON.parse(fs.readFileSync(file, "utf8")); } catch { content = null; }
    const format = backupFormat(content);
    if (!format) return res.status(400).json({ error: "That file is not a valid My Thari backup." });
    const accounts = store.readAccounts();
    if (format === "factory" && !accounts.factories.some(f => f.id === req.body?.factoryId)) {
      return res.status(400).json({ error: "This backup is from a single factory. Choose which factory to restore it into.", needsFactory: true });
    }
    const saved = path.basename(snapshot("before-restore"));
    if (format === "factory") {
      store.writeFactoryRaw(req.body.factoryId, content);
      return res.json({ restored: req.params.name, savedCurrentAs: saved });
    }
    const factories = content.factories.filter(f => f && typeof f.id === "string" && /^FAC-[A-Z0-9-]+$/.test(f.id));
    for (const f of factories) store.writeFactoryRaw(f.id, content.data[f.id] || store.emptyFactoryData());
    accounts.factories = factories;
    for (const u of accounts.users) u.factoryIds = (u.factoryIds || []).filter(id => factories.some(f => f.id === id));
    store.writeAccounts(accounts);
    res.json({ restored: req.params.name, savedCurrentAs: saved, factories: factories.length });
  });

  router.post("/settings", (req, res) => {
    const body = req.body || {};
    const dir = text(body.backupDir);
    const keepDays = Number(body.keepDays);
    if (!dir || !path.isAbsolute(dir)) return res.status(400).json({ error: "Enter a full folder path, e.g. D:\\LoomBackups or /Users/you/LoomBackups." });
    if (!Number.isInteger(keepDays) || keepDays < 1 || keepDays > 3650) return res.status(400).json({ error: "Days to keep must be a whole number from 1 to 3650." });
    const target = path.resolve(dir);
    try {
      fs.mkdirSync(target, { recursive: true });
      const probe = path.join(target, `.write-test-${process.pid}`);
      fs.writeFileSync(probe, "ok");
      fs.unlinkSync(probe);
    } catch (err) {
      return res.status(400).json({ error: `Cannot write to that folder (${err.code || err.message}).` });
    }
    const oldDir = backupConfig().dir;
    let copied = 0;
    if (body.copyExisting && path.resolve(oldDir) !== target && fs.existsSync(oldDir)) {
      for (const b of listBackups()) {
        const dest = path.join(target, b.name);
        if (!fs.existsSync(dest)) { fs.copyFileSync(path.join(oldDir, b.name), dest); copied++; }
      }
      // Log backups live in <folder>/logs and move with the backups.
      const logs = listLogArchives();
      if (logs.length) fs.mkdirSync(path.join(target, "logs"), { recursive: true });
      for (const l of logs) {
        const dest = path.join(target, "logs", l.name);
        if (!fs.existsSync(dest)) { fs.copyFileSync(path.join(oldDir, "logs", l.name), dest); copied++; }
      }
    }
    const s = readSettings();
    s.backupDir = target;
    s.backupKeepDays = keepDays;
    writeSettings(s);
    backupNow();
    res.json({ backupDir: target, keepDays, copied });
  });

  // ---- Version and upgrade ----
  router.post("/upgrade/check", async (_req, res) => {
    try { res.json(await upgrader.checkUpdate()); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post("/upgrade/token", (req, res) => {
    const value = text(req.body?.token);
    if (value && !/^[\w-]{20,255}$/.test(value)) return res.status(400).json({ error: "That does not look like a GitHub token." });
    upgrader.saveToken(value);
    res.json({ hasToken: !!value });
  });

  // Backs up all data, installs the latest version from GitHub and restarts (when supervised).
  router.post("/upgrade", async (_req, res) => {
    try {
      const r = await upgrader.upgrade(() => path.basename(snapshot("before-upgrade")));
      if (r.upToDate) return res.json({ upToDate: true, steps: r.steps });
      const canRestart = process.env.LOOM_SUPERVISED === "1";
      res.json({ ...r, restarting: canRestart });
      if (canRestart) setTimeout(() => process.exit(RESTART_EXIT_CODE), 500);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/restart", (_req, res) => {
    if (process.env.LOOM_SUPERVISED !== "1") {
      return res.status(409).json({ error: "Restart is only available when the app is started with npm start or the Windows launcher." });
    }
    res.json({ restarting: true });
    console.log("Restart requested from Settings.");
    setTimeout(() => process.exit(RESTART_EXIT_CODE), 300);
  });

  return router;
};
