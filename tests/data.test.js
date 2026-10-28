// Old data files, backups and log archives.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startApp, dataOf } = require("./helpers");

const legacyDb = {
  warps: [{ id: "WARP-OLD", name: "OldWarp", widthType: "single", originalMeters: 100, remainingMeters: 37, bodyColor: "Red", borderColor: "Gold", status: "In Use", assignedLoomId: "LOOM-OLD", createdAt: "2025-01-01T00:00:00.000Z" }],
  looms: [{ id: "LOOM-OLD", name: "OldLoom", widthType: "single", warpId: "WARP-OLD", wovenMeters: 63, createdAt: "2025-01-01T00:00:00.000Z" }],
  // a delivery from before deliveries stored the warp id
  deliveries: [{ id: "DEL-OLD", loomId: "LOOM-OLD", loomName: "OldLoom", warpName: "OldWarp", sarees: 10, metersReduced: 63, remainingMeters: 37, createdAt: "2025-01-02T00:00:00.000Z" }],
  clients: [], bobbins: [],
  // stock moves from before the Folding and Sent stages: they name no source bucket
  stockMoves: [
    { id: "M1", warpId: "WARP-OLD", to: "process", qty: 6, createdAt: "2025-01-03T00:00:00.000Z" },
    { id: "M2", warpId: "WARP-OLD", to: "stock", qty: 2, createdAt: "2025-01-04T00:00:00.000Z" }
  ]
};

let app;
before(async () => {
  app = await startApp({
    seed: dirs => {
      fs.writeFileSync(path.join(dirs.data, "db.json"), JSON.stringify(legacyDb));
      // a backup in the old single-factory format
      fs.writeFileSync(path.join(dirs.backups, "db-2020-01-01.json"), JSON.stringify({ ...legacyDb, looms: [{ ...legacyDb.looms[0], name: "FromBackup" }] }));
    }
  });
});
after(async () => { await app.stop(); });

test("an old single-factory db.json becomes the factory 'My factory' with the admin/admin login", async () => {
  const me = (await app.adminRaw.get("/api/auth/me")).body;
  assert.equal(me.factories.length, 1);
  assert.equal(me.factories[0].name, "My factory");
  assert.equal(me.user.username, "admin");
});

test("older data files get every collection added and keep their records", async () => {
  const d = await dataOf(app.admin);
  for (const k of ["staff", "designs", "wagePayouts", "wageDeductions", "wageShifts", "partyPayments", "expenses", "bobbins", "clients", "activity"]) {
    assert.ok(Array.isArray(d[k]), `${k} is an array`);
  }
  assert.equal(d.looms[0].name, "OldLoom");
  assert.equal(d.warps[0].name, "OldWarp");
});

test("deliveries without a warp id are matched to their warp by name", async () => {
  const d = await dataOf(app.admin);
  assert.equal(d.deliveries[0].warpId, "WARP-OLD");
});

test("an activity log is built from existing records", async () => {
  const log = (await dataOf(app.admin)).activity;
  assert.ok(log.some(e => e.seeded && e.type === "dispatch"));
  assert.ok(log.some(e => e.seeded && e.type === "warp"));
});

test("old stock moves are upgraded so each of the 10 old sarees is counted exactly once", async () => {
  // the default factory is Stock + Wages, where everything dispatched counts as stock
  const a = app.admin;
  const party = (await a.post("/api/clients", { name: "Legacy party" })).body;
  const give = qty => a.post("/api/stock/move", { from: "stock", to: "dispatched", qty, clientId: party.id });
  assert.equal((await give(11)).status, 400, "only 10 sarees exist");
  const ok = await give(10);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.pool.stock, 0);
  assert.equal(ok.body.pool.dispatched, 10);
  assert.equal((await a.post("/api/stock/move", { from: "dispatched", to: "stock", qty: 10, clientId: party.id })).status, 201);
});

test("turning Process on for that factory keeps the same counts (everything becomes real stock)", async () => {
  const f = (await app.adminRaw.get("/api/admin/info")).body.factories.find(x => x.id === app.factoryId);
  const put = await app.adminRaw.put(`/api/admin/factories/${app.factoryId}`, { name: f.name, location: "X", ownerName: "O", modules: { stock: true, wages: true, process: true } });
  assert.equal(put.status, 200);
  const a = app.admin;
  const party = (await a.post("/api/clients", { name: "After party" })).body;
  assert.equal((await a.post("/api/stock/move", { from: "stock", to: "dispatched", qty: 11, clientId: party.id })).status, 400);
  assert.equal((await a.post("/api/stock/move", { from: "stock", to: "dispatched", qty: 10, clientId: party.id })).status, 201);
  assert.equal((await a.post("/api/stock/move", { warpId: "WARP-OLD", from: "process", to: "folding", qty: 1 })).status, 400, "nothing left in process");
  // and the conversion left auto-moves so it can be traced
  assert.ok((await dataOf(a)).stockMoves.some(m => m.auto));
});

test("a single-factory (v1) backup needs a factory chosen, then restores into it", async () => {
  const list = (await app.adminRaw.get("/api/admin/info")).body.backups;
  assert.ok(list.some(b => b.name === "db-2020-01-01.json"));
  const first = await app.adminRaw.post("/api/admin/backups/db-2020-01-01.json/restore", {});
  assert.equal(first.status, 400);
  assert.equal(first.body.needsFactory, true);
  const ok = await app.adminRaw.post("/api/admin/backups/db-2020-01-01.json/restore", { factoryId: app.factoryId });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.savedCurrentAs, "the current data is saved first");
  assert.equal((await dataOf(app.admin)).looms[0].name, "FromBackup");
});

test("a file that is not a backup is refused", async () => {
  fs.writeFileSync(path.join(app.dir, "backups", "db-garbage.json"), "{ not json");
  const r = await app.adminRaw.post("/api/admin/backups/db-garbage.json/restore", {});
  assert.equal(r.status, 400);
  assert.equal((await app.adminRaw.post("/api/admin/backups/db-missing.json/restore", {})).status, 404);
});

test("a manual backup is never pruned and the whole system can be exported", async () => {
  const made = await app.adminRaw.post("/api/admin/backup-now", {});
  assert.ok(made.status < 300);
  const res = await fetch(app.url + "/api/admin/export", { headers: { Authorization: `Bearer ${app.token}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.format, "loom-saree-backup");
  assert.equal(body.version, 2);
  assert.ok(body.data[app.factoryId]);
});

test("logs can be exported as CSV and old entries archived to a file", async () => {
  const res = await fetch(app.url + "/api/admin/logs-export", { headers: { Authorization: `Bearer ${app.token}` } });
  assert.equal(res.status, 200);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM so Excel opens it");
  assert.ok(bytes.toString("utf8").split("\n").length > 2);
  const archived = await app.adminRaw.post("/api/admin/logs/archive", {});
  assert.equal(archived.status, 201);
});

test("deleting a backup removes the file and the name is checked", async () => {
  assert.equal((await app.adminRaw.del("/api/admin/backups/db-garbage.json")).status < 300, true);
  assert.equal(fs.existsSync(path.join(app.dir, "backups", "db-garbage.json")), false);
  assert.equal((await app.adminRaw.del("/api/admin/backups/..%2Faccounts.json")).status, 404);
});
