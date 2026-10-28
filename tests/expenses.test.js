const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startApp, dataOf } = require("./helpers");

let app, f, a, loom, warp, bobbin;
before(async () => {
  app = await startApp();
  f = await app.newFactory({ modules: { stock: true, wages: true } });
  a = f.api;
  loom = (await a.post("/api/looms", { name: "L1", widthType: "single" })).body;
  warp = (await a.post("/api/warps", { name: "W1", widthType: "single", meters: 100, bodyColor: "R", borderColor: "G" })).body;
  bobbin = (await a.post("/api/bobbins", { name: "B1", widthType: "single", meters: 100, color: "Blue" })).body;
});
after(async () => { await app.stop(); });

const add = body => a.post("/api/expenses", { loomId: loom.id, amount: 100, ...body });

test("every expense needs a loom, a type and an amount above 0", async () => {
  assert.equal((await a.post("/api/expenses", { kind: "spares", amount: 5, item: "x" })).status, 400, "loom");
  assert.equal((await add({ kind: "bogus" })).status, 400, "type");
  assert.equal((await add({ kind: "maintenance", amount: 0 })).status, 400);
  assert.equal((await add({ kind: "maintenance", amount: "x" })).status, 400);
  assert.equal((await add({ kind: "maintenance", date: "2026-02-31" })).status, 400, "date");
  assert.equal((await add({ kind: "spares", item: "x", qty: 0 })).status, 400, "quantity");
});

test("spares need the spare part's name", async () => {
  assert.equal((await add({ kind: "spares" })).status, 400);
  const r = await add({ kind: "spares", item: "Shuttle", qty: 2, vendor: "Ravi Stores", billNo: "B-12", note: "urgent" });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.item, r.body.qty, r.body.vendor, r.body.billNo, r.body.label, r.body.loomName], ["Shuttle", 2, "Ravi Stores", "B-12", "Spares", "L1"]);
});

test("warp join can name the warp joined; unknown warps are ignored", async () => {
  const r = await add({ kind: "warp_join", warpId: warp.id, vendor: "Joiner" });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.warpId, r.body.warpName], [warp.id, "W1"]);
  assert.equal((await add({ kind: "warp_join", warpId: "nope" })).body.warpId, null);
});

test("bobbin join can name the bobbin joined", async () => {
  const r = await add({ kind: "bobbin_join", bobbinId: bobbin.id });
  assert.equal(r.status, 201);
  assert.equal(r.body.bobbinName, "B1");
});

test("maintenance has a kind (routine / repair / breakdown / other)", async () => {
  assert.equal((await add({ kind: "maintenance", subtype: "Repair" })).body.subtype, "Repair");
  assert.equal((await add({ kind: "maintenance", subtype: "Whatever" })).body.subtype, "", "unknown kind is dropped");
});

test("date defaults to today and amounts are rounded to 2 places", async () => {
  const r = await add({ kind: "maintenance", amount: 10.456 });
  assert.equal(r.body.date, new Date().toISOString().slice(0, 10));
  assert.equal(r.body.amount, 10.46);
});

test("edit and remove an expense; both are logged", async () => {
  const e = (await add({ kind: "maintenance", amount: 900 })).body;
  const up = await a.put(`/api/expenses/${e.id}`, { loomId: loom.id, kind: "maintenance", amount: 950, subtype: "Breakdown" });
  assert.equal(up.status, 200);
  assert.equal(up.body.amount, 950);
  assert.equal((await a.put("/api/expenses/missing", { loomId: loom.id, kind: "spares", amount: 1, item: "x" })).status, 404);
  assert.equal((await a.del(`/api/expenses/${e.id}`)).status, 200);
  assert.equal((await a.del(`/api/expenses/${e.id}`)).status, 404);
  const log = (await dataOf(a)).activity.filter(x => x.type === "expense").map(x => x.text);
  assert.ok(log.some(t => /Expense edited: Maintenance ₹950 on L1/.test(t)));
  assert.ok(log.some(t => /Expense removed/.test(t)));
});

test("an expense keeps the loom name when the loom is removed", async () => {
  const l2 = (await a.post("/api/looms", { name: "GoneLoom", widthType: "single" })).body;
  await a.post("/api/expenses", { loomId: l2.id, kind: "maintenance", amount: 5 });
  assert.equal((await a.del(`/api/looms/${l2.id}`)).status, 200);
  assert.ok((await dataOf(a)).expenses.some(x => x.loomName === "GoneLoom"));
});

test("expenses are scoped to their factory and stored newest first", async () => {
  const other = await app.newFactory({ modules: { stock: true, wages: true } });
  assert.equal((await dataOf(other.api)).expenses.length, 0);
  const list = (await dataOf(a)).expenses;
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].createdAt >= list[i].createdAt);
  // an expense cannot be saved against a loom of another factory
  const foreign = (await other.api.post("/api/looms", { name: "Foreign", widthType: "single" })).body;
  assert.equal((await a.post("/api/expenses", { loomId: foreign.id, kind: "maintenance", amount: 5 })).status, 400);
});
