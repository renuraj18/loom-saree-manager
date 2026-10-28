const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startApp, runningLoom } = require("./helpers");

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

const base = { location: "Salem", ownerName: "Owner" };

test("factory needs name, location and owner; names are unique", async () => {
  assert.equal((await app.adminRaw.post("/api/admin/factories", { name: "", ...base })).status, 400);
  assert.equal((await app.adminRaw.post("/api/admin/factories", { name: "F1", location: "", ownerName: "O" })).status, 400);
  assert.equal((await app.adminRaw.post("/api/admin/factories", { name: "Dup", ...base })).status, 201);
  const dup = await app.adminRaw.post("/api/admin/factories", { name: "dup", ...base });
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /already exists/);
});

test("the old Wages-only type is rejected; Stock only and Stock + Wages are accepted", async () => {
  const r = await app.adminRaw.post("/api/admin/factories", { name: "WagesOnly", ...base, modules: { stock: false, wages: true } });
  assert.equal(r.status, 400);
  const a = await app.adminRaw.post("/api/admin/factories", { name: "StockOnly", ...base, modules: { stock: true, wages: false } });
  assert.equal(a.status, 201);
  const b = await app.adminRaw.post("/api/admin/factories", { name: "Both", ...base, modules: { stock: true, wages: true, process: true } });
  assert.equal(b.status, 201);
  assert.equal(b.body.modules.process, true);
});

test("Stock only: staff, designs, wages and expenses are turned off (403); stock and parties work", async () => {
  const f = await app.newFactory({ modules: { stock: true, wages: false } });
  for (const p of ["/api/designs", "/api/wages/shifts"]) {
    const r = p === "/api/designs" ? await f.api.post(p, { number: "D", rate: 10 }) : await f.api.post(p, {});
    assert.equal(r.status, 403, p);
  }
  assert.equal((await f.api.post("/api/staff", { name: "X" })).status, 403);
  assert.equal((await f.api.post("/api/expenses", { loomId: "x", kind: "spares", amount: 1, item: "a" })).status, 403);
  assert.equal((await f.api.post("/api/clients", { name: "Party" })).status, 201);
});

test("Stock + Wages: staff, designs and expenses work", async () => {
  const f = await app.newFactory({ modules: { stock: true, wages: true } });
  assert.equal((await f.api.post("/api/staff", { name: "Ravi" })).status, 201);
  assert.equal((await f.api.post("/api/designs", { number: "D1", rate: 10 })).status, 201);
  const loom = (await f.api.post("/api/looms", { name: "L1", widthType: "single" })).body;
  assert.equal((await f.api.post("/api/expenses", { loomId: loom.id, kind: "spares", amount: 5, item: "Shuttle" })).status, 201);
});

test("wage basis and shifts are validated", async () => {
  const f = await app.newFactory();
  const put = body => app.adminRaw.put(`/api/admin/factories/${f.id}`, { name: f.factory.name, ...base, ...body });
  const good = [{ name: "Day", start: "06:00", hours: 8, rate: 600 }];
  assert.equal((await put({ wageBasis: "shift", shifts: [] })).status, 400, "shift mode needs a shift");
  assert.equal((await put({ wageBasis: "shift", shifts: [{ ...good[0], rate: 0 }] })).status, 400, "and a rate");
  assert.equal((await put({ wageBasis: "saree", shifts: [{ ...good[0], start: "6am" }] })).status, 400, "bad start time");
  assert.equal((await put({ wageBasis: "saree", shifts: [{ ...good[0], hours: 30 }] })).status, 400, "bad hours");
  assert.equal((await put({ wageBasis: "saree", shifts: [{ ...good[0], name: "" }] })).status, 400, "name required");
  assert.equal((await put({ wageBasis: "shift", shifts: [good[0], { ...good[0], name: "DAY" }] })).status, 400, "unique names");
  const ok = await put({ wageBasis: "shift", shifts: [good[0], { name: "Night", start: "18:00", hours: 8, rate: 700 }] });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.wageBasis, "shift");
  assert.equal(ok.body.shifts.length, 2);
  assert.equal(ok.body.shiftBad, undefined, "internal flag is not stored");
});

test("a legacy single `shift` object is read as Shift 1", async () => {
  const f = await app.newFactory();
  const r = await app.adminRaw.put(`/api/admin/factories/${f.id}`, { name: f.factory.name, ...base, wageBasis: "shift", shift: { start: "06:00", hours: 8, rate: 500 } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.shifts, [{ name: "Shift 1", start: "06:00", hours: 8, rate: 500 }]);
});

test("each factory's data is separate", async () => {
  const a = await app.newFactory(), b = await app.newFactory();
  await a.api.post("/api/looms", { name: "OnlyInA", widthType: "single" });
  assert.equal((await b.api.get("/api/data")).body.looms.length, 0);
  assert.equal((await a.api.get("/api/data")).body.looms.length, 1);
});

test("reset and delete need the exact factory name and keep a backup", async () => {
  const f = await app.newFactory();
  await f.api.post("/api/looms", { name: "L", widthType: "single" });
  assert.equal((await app.adminRaw.post(`/api/admin/factories/${f.id}/reset`, { confirmName: "wrong" })).status, 400);
  const reset = await app.adminRaw.post(`/api/admin/factories/${f.id}/reset`, { confirmName: f.factory.name });
  assert.equal(reset.status, 200);
  assert.ok(reset.body.savedAs);
  assert.equal((await f.api.get("/api/data")).body.looms.length, 0);
  assert.equal((await app.adminRaw.del(`/api/admin/factories/${f.id}`, { confirmName: "nope" })).status, 400);
  assert.equal((await app.adminRaw.del(`/api/admin/factories/${f.id}`, { confirmName: f.factory.name })).status, 200);
});

test("Stock + Wages hides Process (sarees count as stock); ticking Include Process brings it back and keeps counts", async () => {
  const f = await app.newFactory({ modules: { stock: true, wages: true } });
  const { loom } = await runningLoom(f.api);
  const party = (await f.api.post("/api/clients", { name: "P" })).body;
  await f.api.post("/api/deliveries", { loomId: loom.id, sarees: 4 });
  const give = qty => f.api.post("/api/stock/move", { from: "stock", to: "dispatched", qty, clientId: party.id });
  assert.equal((await give(3)).status, 201, "dispatched sarees are stock straight away");
  const put = modules => app.adminRaw.put(`/api/admin/factories/${f.id}`, { name: f.factory.name, ...base, modules });
  assert.equal((await put({ stock: true, wages: true, process: true })).status, 200);
  // the 1 remaining saree was converted to real stock; new dispatches now go through Process
  assert.equal((await give(2)).status, 400);
  assert.equal((await give(1)).status, 201);
  await f.api.post("/api/deliveries", { loomId: loom.id, sarees: 2 });
  assert.equal((await give(1)).status, 400, "new sarees wait in Process now");
});

test("backup files can be created, listed and restored", async () => {
  const f = await app.newFactory();
  await f.api.post("/api/looms", { name: "KeepMe", widthType: "single" });
  const made = await app.adminRaw.post("/api/admin/backup-now", {});
  assert.ok(made.status < 300);
  const info = (await app.adminRaw.get("/api/admin/info")).body;
  assert.ok(info.backups.length >= 1);
  const name = info.backups[0].name;
  await f.api.post("/api/looms", { name: "AddedLater", widthType: "single" });
  // restoring a whole-system backup replaces the factory data with what it held
  const restored = await app.adminRaw.post(`/api/admin/backups/${name}/restore`, {});
  assert.equal(restored.status, 200);
  const looms = (await f.api.get("/api/data")).body.looms.map(l => l.name);
  assert.ok(looms.includes("KeepMe"));
});

test("backup names are checked (no path traversal)", async () => {
  assert.equal((await app.adminRaw.get("/api/admin/backups/..%2F..%2Fetc%2Fpasswd")).status, 404);
  assert.equal((await app.adminRaw.get("/api/admin/backups/accounts.json")).status, 404);
});
