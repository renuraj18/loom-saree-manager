// Sign-in, sessions and access checks.
// Sessions are stateless signed tokens "<userId>.<tokenVersion>.<expiry>.<hmac>" (secret in
// settings.json), so they survive restarts. Bumping a user's tokenVersion (password change,
// role/factory change by an admin, deletion) signs that user out everywhere.
const express = require("express");
const crypto = require("crypto");
const { readSettings, writeSettings } = require("./paths");
const { readAccounts, writeAccounts, hashPassword, verifyPassword, canAccessFactory, publicUser } = require("./store");

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function secret() {
  const s = readSettings();
  if (s.sessionSecret) return s.sessionSecret;
  s.sessionSecret = crypto.randomBytes(32).toString("hex");
  writeSettings(s);
  return s.sessionSecret;
}
const sign = payload => crypto.createHmac("sha256", secret()).update(payload).digest("hex");

function issueToken(user) {
  const payload = `${user.id}.${user.tokenVersion || 0}.${Date.now() + SESSION_MS}`;
  return `${payload}.${sign(payload)}`;
}
function userFromToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 4) return null;
  const [id, version, exp, mac] = parts;
  const expected = sign(`${id}.${version}.${exp}`);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  if (Number(exp) < Date.now()) return null;
  const user = readAccounts().users.find(u => u.id === id);
  return user && String(user.tokenVersion || 0) === version ? user : null;
}

function requireAuth(req, res, next) {
  const user = userFromToken((req.get("authorization") || "").replace(/^Bearer\s+/i, ""));
  if (!user) return res.status(401).json({ error: "Please sign in." });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Only an admin can do this." });
  next();
}
// Data routes act on the factory named in the X-Factory header, if this user may open it.
function factoryScope(req, res, next) {
  const factoryId = req.get("x-factory");
  const factory = readAccounts().factories.find(f => f.id === factoryId);
  if (!factory) return res.status(400).json({ error: "Select a factory first." });
  if (!canAccessFactory(req.user, factoryId)) return res.status(403).json({ error: "You do not have access to this factory." });
  req.factoryId = factoryId;
  req.factory = factory;
  next();
}

function factoriesFor(user, accounts = readAccounts()) {
  return accounts.factories.filter(f => canAccessFactory(user, f.id));
}

function authRouter() {
  const router = express.Router();

  router.post("/login", (req, res) => {
    const username = String(req.body?.username || "").trim().toLowerCase();
    const user = readAccounts().users.find(u => u.username.toLowerCase() === username);
    if (!user || !verifyPassword(user, String(req.body?.password || ""))) {
      // Small delay makes password guessing slower.
      return setTimeout(() => res.status(401).json({ error: "Wrong username or password." }), 600);
    }
    res.json({ token: issueToken(user), user: publicUser(user), factories: factoriesFor(user) });
  });

  router.get("/me", requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user), factories: factoriesFor(req.user) });
  });

  router.post("/password", requireAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!verifyPassword(req.user, String(currentPassword || ""))) return res.status(400).json({ error: "Current password is wrong." });
    if (String(newPassword || "").length < 4) return res.status(400).json({ error: "New password must be at least 4 characters." });
    const accounts = readAccounts();
    const user = accounts.users.find(u => u.id === req.user.id);
    Object.assign(user, hashPassword(newPassword));
    user.tokenVersion = (user.tokenVersion || 0) + 1; // signs out this user's other sessions
    delete user.defaultPassword;
    writeAccounts(accounts);
    res.json({ token: issueToken(user), user: publicUser(user) });
  });

  return router;
}

module.exports = { requireAuth, requireAdmin, factoryScope, factoriesFor, authRouter };
