// Licensing. Two editions:
//   factory — a weaving unit managing its own factory (one factory, no party features)
//   party   — a job-work giver managing several factories (party app, factory registration, approvals …)
// A license is an Ed25519-signed key issued by the vendor (scripts/issue-license.js):
//   MYTHARI1.<base64url(JSON payload)>.<base64url(signature over the base64 payload)>
//   payload { v: 1, id, edition, licensee, phone?, installId, maxFactories, maxLooms, issuedAt, expiresAt "YYYY-MM-DD", checkinUrl? }
// It is locked to one PC by installId (settings.installId, made on first start) and checked offline against
// the public key in license-key.js. With a checkinUrl the app also checks in about once a week
// (POST { licenseId, installId, version, edition, usage }); the server may answer { revoked: true, message }.
// No successful check-in for OFFLINE_DAYS makes the app read-only until it reaches the server again.
// Without a license the install runs a TRIAL_DAYS trial (party features, small limits).
// After expiry there are GRACE_DAYS of grace (warnings only), then the app is read-only: every page still
// opens and shows data, but changes are refused except licensing, backups, settings, upgrade and sign-in.
// This deters casual copying; the app ships as plain JavaScript, so it is not tamper-proof.
const crypto = require("crypto");
const { readSettings, writeSettings } = require("./paths");
const store = require("./store");

const TRIAL_DAYS = 30, GRACE_DAYS = 15, WARN_DAYS = 15, OFFLINE_DAYS = 30;
const CHECKIN_EVERY_MS = 7 * 864e5, CHECKIN_RETRY_MS = 6 * 3600e3;
const TRIAL_LIMITS = { maxFactories: 2, maxLooms: 10 };
const EDITIONS = {
  factory: { label: "Factory", party: false },
  party: { label: "Party (job work)", party: true },
  trial: { label: "Trial", party: true }
};
const DAY = 864e5;

// Tests pass their own key in LICENSE_PUBLIC_KEY; real installs use the vendor key in license-key.js.
function publicKey() {
  const pem = process.env.LICENSE_PUBLIC_KEY || require("./license-key").PUBLIC_KEY;
  try { return pem ? crypto.createPublicKey(pem) : null; } catch { return null; }
}

// This PC's install id (and the trial start), made once and kept in settings.json.
function installId() {
  const s = readSettings();
  if (s.installId && s.trialStartedAt) return s.installId;
  s.installId ||= "INS-" + crypto.randomBytes(6).toString("hex").toUpperCase().match(/.{4}/g).join("-");
  s.trialStartedAt ||= new Date().toISOString();
  writeSettings(s);
  return s.installId;
}

function sign(payload, privateKeyPem) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.sign(null, Buffer.from(body), crypto.createPrivateKey(privateKeyPem));
  return `MYTHARI1.${body}.${sig.toString("base64url")}`;
}

// Verifies a key's signature and shape. Returns { payload } or { error }.
function decode(key) {
  const m = /^MYTHARI1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(key || "").replace(/\s+/g, ""));
  if (!m) return { error: "This is not a My Thari license key." };
  const pk = publicKey();
  if (!pk) return { error: "This copy of the app cannot check license keys yet. Ask your supplier for an update." };
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(m[1]), pk, Buffer.from(m[2], "base64url")); } catch { ok = false; }
  if (!ok) return { error: "This license key is not valid (signature check failed)." };
  let p;
  try { p = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")); } catch { return { error: "This license key is damaged." }; }
  if (p.v !== 1 || !["factory", "party"].includes(p.edition) || !/^\d{4}-\d{2}-\d{2}$/.test(p.expiresAt || "") || !p.installId) return { error: "This license key is not for this version of the app." };
  return { payload: p };
}

const endOfDay = ymd => { const [y, mo, d] = ymd.split("-").map(Number); return new Date(y, mo - 1, d, 23, 59, 59).getTime(); };
const ymd = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// The licence state right now (cheap: settings + one signature check). Fields:
//   state: trial | trial-ended | active | expiring | grace | expired | revoked | offline | wrong-pc | invalid
//   readOnly, edition, editionLabel, party (party features allowed), maxFactories, maxLooms, expiresAt, daysLeft, message …
function state(now = Date.now()) {
  const id = installId();
  const s = readSettings();
  if (!s.license) {
    const end = Date.parse(s.trialStartedAt) + TRIAL_DAYS * DAY;
    const left = Math.ceil((end - now) / DAY);
    return {
      state: left > 0 ? "trial" : "trial-ended", readOnly: left <= 0, edition: "trial", editionLabel: EDITIONS.trial.label, party: true,
      ...TRIAL_LIMITS, expiresAt: ymd(end), daysLeft: Math.max(0, left), installId: id,
      message: left > 0 ? `Trial: ${left} day${left === 1 ? "" : "s"} left (up to ${TRIAL_LIMITS.maxFactories} factories and ${TRIAL_LIMITS.maxLooms} looms). Add a license key in Settings.`
        : "The trial has ended. Add a license key in Settings to keep entering data."
    };
  }
  const d = decode(s.license);
  if (d.error) return { state: "invalid", readOnly: true, edition: "none", editionLabel: "None", party: false, maxFactories: 0, maxLooms: 0, installId: id, message: d.error };
  const p = d.payload;
  const base = { edition: p.edition, editionLabel: EDITIONS[p.edition].label, party: EDITIONS[p.edition].party, licensee: p.licensee || "", licenseId: p.id || "",
    maxFactories: p.maxFactories, maxLooms: p.maxLooms, expiresAt: p.expiresAt, installId: id, checkinUrl: p.checkinUrl || "" };
  if (p.installId !== id) return { ...base, state: "wrong-pc", readOnly: true, message: `This license is for another PC (${p.installId}). This PC is ${id}.` };
  const left = Math.ceil((endOfDay(p.expiresAt) - now) / DAY);
  const graceUntil = ymd(endOfDay(p.expiresAt) + GRACE_DAYS * DAY);
  let st = left > WARN_DAYS ? "active" : left >= 0 ? "expiring" : left >= -GRACE_DAYS ? "grace" : "expired";
  const c = s.licenseCheck && s.licenseCheck.licenseId === p.id ? s.licenseCheck : {};
  const checkin = p.checkinUrl ? { lastOkAt: c.lastOkAt || null, lastTryAt: c.lastTryAt || null, error: c.error || "" } : null;
  if (c.revoked) st = "revoked";
  else if (p.checkinUrl && st !== "expired") {
    const lastOk = Date.parse(c.lastOkAt || s.licenseAddedAt || p.issuedAt) || now;
    if (now - lastOk > OFFLINE_DAYS * DAY) st = "offline";
  }
  const msg = {
    active: "",
    expiring: `The license expires on ${p.expiresAt} (${left} day${left === 1 ? "" : "s"}). Renew it to avoid interruption.`,
    grace: `The license expired on ${p.expiresAt}. Entries are allowed until ${graceUntil}; renew it before then.`,
    expired: `The license expired on ${p.expiresAt}.`,
    revoked: c.message || "This license has been withdrawn by the supplier.",
    offline: `The app has not been able to verify its license online for over ${OFFLINE_DAYS} days. Connect this PC to the internet.`
  }[st];
  return { ...base, state: st, readOnly: ["expired", "revoked", "offline"].includes(st), daysLeft: left, graceUntil, checkin, message: msg };
}

// What is in use now, compared against the limits.
function usage() {
  const a = store.readAccounts();
  let looms = 0;
  for (const f of a.factories) looms += (store.readFactoryRaw(f.id).looms || []).length;
  return { factories: a.factories.length, looms };
}
// Error message if one more factory / loom would go over the license, else "".
function limitError(kind, st = state()) {
  const u = usage();
  if (kind === "factory" && u.factories >= st.maxFactories) return `Your ${st.editionLabel} license allows ${st.maxFactories} factor${st.maxFactories === 1 ? "y" : "ies"}. Upgrade the license to add more.`;
  if (kind === "loom" && u.looms >= st.maxLooms) return `Your ${st.editionLabel} license allows ${st.maxLooms} looms in all. Upgrade the license to add more.`;
  return "";
}

// Requests that keep working when read-only: sign-in, licensing, backups/restore, settings, logs, upgrade, restart.
const READ_ONLY_OK = [/^\/auth\//, /^\/admin\/license/, /^\/admin\/backup/, /^\/admin\/export/, /^\/admin\/settings/, /^\/admin\/logs/, /^\/admin\/upgrade/, /^\/admin\/restart/];
// Mount at /api: refuses changes while the license is read-only.
function readOnlyGuard(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || READ_ONLY_OK.some(r => r.test(req.path))) return next();
  const st = state();
  if (!st.readOnly) return next();
  res.status(403).json({ error: `${st.message} The app is read-only until the license is renewed.`, code: "LICENSE_READ_ONLY" });
}
// Party features (party app, party accounts, factory registration by parties) need the Party edition or the trial.
function needPartyEdition(req, res, next) {
  if (state().party) return next();
  res.status(403).json({ error: "Party features need a Party (job work) license. This PC has a Factory license.", code: "LICENSE_EDITION" });
}
// Mount before a factory/loom create route.
const needRoom = kind => (req, res, next) => {
  const err = limitError(kind);
  if (err) return res.status(403).json({ error: err, code: "LICENSE_LIMIT" });
  next();
};

// What the pages need for their banner (no install id or check-in details for non-admins).
const publicState = (st = state()) => ({ state: st.state, readOnly: st.readOnly, edition: st.edition, editionLabel: st.editionLabel, party: st.party,
  expiresAt: st.expiresAt || null, daysLeft: st.daysLeft ?? null, message: st.message || "" });

// Saves a key after checking it is valid and for this PC. Returns { state } or { error }.
function install(key) {
  const d = decode(key);
  if (d.error) return { error: d.error };
  const id = installId();
  if (d.payload.installId !== id) return { error: `This key is for another PC (${d.payload.installId}). This PC's install ID is ${id}.` };
  const s = readSettings();
  s.license = String(key).replace(/\s+/g, "");
  s.licenseAddedAt = new Date().toISOString();
  delete s.licenseCheck;
  writeSettings(s);
  return { state: state() };
}
function remove() {
  const s = readSettings();
  delete s.license; delete s.licenseAddedAt; delete s.licenseCheck;
  writeSettings(s);
}

// Online check-in. Runs at most weekly (every 6 h after a failure) unless forced.
async function checkin(force = false, version = "") {
  const s = readSettings();
  if (!s.license) return null;
  const d = decode(s.license);
  if (d.error || !d.payload.checkinUrl) return null;
  const p = d.payload;
  const c = s.licenseCheck && s.licenseCheck.licenseId === p.id ? { ...s.licenseCheck } : { licenseId: p.id };
  const wait = c.error ? CHECKIN_RETRY_MS : CHECKIN_EVERY_MS;
  if (!force && c.lastTryAt && Date.now() - Date.parse(c.lastTryAt) < wait) return c;
  c.lastTryAt = new Date().toISOString();
  try {
    const r = await fetch(p.checkinUrl, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseId: p.id, installId: installId(), version, edition: p.edition, usage: usage() }), signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `license server answered ${r.status}`);
    Object.assign(c, { lastOkAt: new Date().toISOString(), revoked: j.revoked === true, message: String(j.message || ""), error: "" });
  } catch (e) {
    c.error = e.name === "TimeoutError" ? "license server did not answer" : e.message;
  }
  const s2 = readSettings();
  if (s2.license === s.license) { s2.licenseCheck = c; writeSettings(s2); }
  return c;
}

module.exports = { state, usage, limitError, readOnlyGuard, needPartyEdition, needRoom, publicState, install, remove, checkin, decode, sign, installId,
  TRIAL_DAYS, GRACE_DAYS, OFFLINE_DAYS, TRIAL_LIMITS, EDITIONS };
