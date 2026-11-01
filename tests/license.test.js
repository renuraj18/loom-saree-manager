// Licensing: trial, Factory vs Party editions, factory/loom limits, PC lock, expiry grace and read-only,
// online check-in with revocation, and offline too long.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { startApp, issueKey, TEST_INSTALL } = require("./helpers");

const ymd = days => { const d = new Date(Date.now() + days * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const addLooms = async (a, n, prefix = "L") => { const out = []; for (let i = 0; i < n; i++) out.push(await a.post("/api/looms", { name: `${prefix}${i}`, widthType: "single" })); return out; };

test("a new install runs a trial with party features and small limits", async () => {
  const app = await startApp({ license: false });
  try {
    const lic = (await app.adminRaw.get("/api/admin/license")).body;
    assert.equal(lic.state, "trial");
    assert.equal(lic.edition, "trial");
    assert.equal(lic.party, true);
    assert.equal(lic.installId, TEST_INSTALL);
    assert.equal(lic.usage.factories, 1);
    const me = (await app.adminRaw.get("/api/auth/me")).body;
    assert.equal(me.license.state, "trial");
    assert.equal(me.license.installId, undefined, "pages get no install id");
    // 2 factories, 10 looms
    assert.equal((await app.adminRaw.post("/api/admin/factories", { name: "Second", location: "X", ownerName: "O" })).status, 201);
    const third = await app.adminRaw.post("/api/admin/factories", { name: "Third", location: "X", ownerName: "O" });
    assert.equal(third.status, 403);
    assert.equal(third.body.code, "LICENSE_LIMIT");
    const looms = await addLooms(app.admin, 11);
    assert.deepEqual(looms.map(r => r.status), [...Array(10).fill(201), 403]);
    assert.equal((await app.adminRaw.post("/api/admin/parties", { name: "P", username: "ppp", password: "pass" })).status, 201, "trial allows party features");
  } finally { await app.stop(); }
});

test("an ended trial makes the app read-only but keeps it viewable", async () => {
  const app = await startApp({ license: false, settings: { trialStartedAt: new Date(Date.now() - 31 * 864e5).toISOString() } });
  try {
    const lic = (await app.adminRaw.get("/api/admin/license")).body;
    assert.equal(lic.state, "trial-ended");
    assert.equal(lic.readOnly, true);
    assert.equal((await app.admin.get("/api/data")).status, 200);
    const w = await app.admin.post("/api/warps", { name: "W", widthType: "single", meters: 63, bodyColor: "a", borderColor: "b" });
    assert.equal(w.status, 403);
    assert.equal(w.body.code, "LICENSE_READ_ONLY");
    assert.ok((await app.adminRaw.post("/api/admin/backup-now")).status < 300, "backups still work");
    // Adding a key lifts it.
    const r = await app.adminRaw.post("/api/admin/license", { key: issueKey({ edition: "factory", maxFactories: 1, maxLooms: 20 }) });
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "active");
    assert.equal((await app.admin.post("/api/warps", { name: "W", widthType: "single", meters: 63, bodyColor: "a", borderColor: "b" })).status, 201);
  } finally { await app.stop(); }
});

test("keys are checked: forged, wrong PC and damaged keys are refused", async () => {
  const app = await startApp({ license: false });
  try {
    const bad = issueKey();
    const forged = bad.slice(0, -4) + (bad.endsWith("AAAA") ? "BBBB" : "AAAA");
    assert.equal((await app.adminRaw.post("/api/admin/license", { key: forged })).status, 400);
    assert.equal((await app.adminRaw.post("/api/admin/license", { key: "hello" })).status, 400);
    const other = await app.adminRaw.post("/api/admin/license", { key: issueKey({ installId: "INS-AAAA-BBBB-CCCC" }) });
    assert.equal(other.status, 400);
    assert.match(other.body.error, /another PC/);
    assert.equal((await app.adminRaw.post("/api/auth/login", { username: "x", password: "y" })).status, 401, "sign-in unaffected");
  } finally { await app.stop(); }
});

test("a Factory license has no party features and counts factories and looms", async () => {
  const app = await startApp({ license: { edition: "factory", maxFactories: 1, maxLooms: 3 } });
  try {
    const lic = (await app.adminRaw.get("/api/admin/license")).body;
    assert.equal(lic.edition, "factory");
    assert.equal(lic.party, false);
    const p = await app.adminRaw.post("/api/admin/parties", { name: "P", username: "ppp", password: "pass" });
    assert.equal(p.status, 403);
    assert.equal(p.body.code, "LICENSE_EDITION");
    assert.equal((await app.adminRaw.post("/api/admin/factories", { name: "Second", location: "X", ownerName: "O" })).status, 403);
    assert.deepEqual((await addLooms(app.admin, 4)).map(r => r.status), [201, 201, 201, 403]);
  } finally { await app.stop(); }
});

test("a Party license limits the factories a party registers and the looms it adds", async () => {
  const app = await startApp({ license: { edition: "party", maxFactories: 2, maxLooms: 1 } });
  try {
    await app.adminRaw.post("/api/admin/parties", { name: "P", username: "ppp", password: "pass" });
    const pa = app.api((await app.login("ppp", "pass")).token);
    const f = await pa.post("/api/party/factories", { name: "F1", ownerName: "O", username: "own1", password: "pass" });
    assert.equal(f.status, 201);
    const f2 = await pa.post("/api/party/factories", { name: "F2", ownerName: "O", username: "own2", password: "pass" });
    assert.equal(f2.status, 403, "default factory + F1 = 2");
    assert.equal((await pa.post(`/api/party/factories/${f.body.factory.id}/looms`, { name: "L1", widthType: "single" })).status, 201);
    assert.equal((await pa.post(`/api/party/factories/${f.body.factory.id}/looms`, { name: "L2", widthType: "single" })).status, 403);
  } finally { await app.stop(); }
});

test("expiry: warning, then grace with entries allowed, then read-only", async () => {
  const soon = await startApp({ license: { expiresAt: ymd(5) } });
  try {
    const l = (await soon.adminRaw.get("/api/admin/license")).body;
    assert.equal(l.state, "expiring");
    assert.equal(l.readOnly, false);
  } finally { await soon.stop(); }
  const grace = await startApp({ license: { expiresAt: ymd(-5) } });
  try {
    const l = (await grace.adminRaw.get("/api/admin/license")).body;
    assert.equal(l.state, "grace");
    assert.equal((await grace.admin.post("/api/looms", { name: "L", widthType: "single" })).status, 201);
  } finally { await grace.stop(); }
  const expired = await startApp({ license: { expiresAt: ymd(-20) } });
  try {
    const l = (await expired.adminRaw.get("/api/admin/license")).body;
    assert.equal(l.state, "expired");
    assert.equal(l.readOnly, true);
    assert.equal((await expired.admin.post("/api/looms", { name: "L", widthType: "single" })).status, 403);
    assert.equal((await expired.adminRaw.get("/api/auth/me")).body.license.readOnly, true);
  } finally { await expired.stop(); }
});

test("online check-in: the vendor can withdraw a license and restore it", async () => {
  let revoked = true, seen = null;
  const srv = http.createServer((req, res) => {
    let raw = ""; req.on("data", c => { raw += c; }); req.on("end", () => {
      seen = JSON.parse(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(revoked ? { revoked: true, message: "Payment pending" } : { ok: true }));
    });
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/checkin`;
  const app = await startApp({ license: { checkinUrl: url } });
  try {
    const r = (await app.adminRaw.post("/api/admin/license/checkin")).body;
    assert.equal(seen.installId, TEST_INSTALL);
    assert.equal(seen.usage.factories, 1);
    assert.equal(r.state, "revoked");
    assert.equal(r.message, "Payment pending");
    assert.equal((await app.admin.post("/api/looms", { name: "L", widthType: "single" })).status, 403);
    revoked = false;
    const ok = (await app.adminRaw.post("/api/admin/license/checkin")).body;
    assert.equal(ok.state, "active");
    assert.ok(ok.checkin.lastOkAt);
    assert.equal((await app.admin.post("/api/looms", { name: "L", widthType: "single" })).status, 201);
  } finally { await app.stop(); srv.close(); }
});

test("a license that must check in turns read-only after 30 days without reaching the server", async () => {
  const app = await startApp({ license: { checkinUrl: "http://127.0.0.1:9/checkin", issuedAt: new Date(Date.now() - 60 * 864e5).toISOString() },
    settings: { licenseAddedAt: new Date(Date.now() - 40 * 864e5).toISOString() } });
  try {
    const r = (await app.adminRaw.post("/api/admin/license/checkin")).body;
    assert.equal(r.state, "offline");
    assert.equal(r.readOnly, true);
    assert.ok(r.checkin.error);
  } finally { await app.stop(); }
});
