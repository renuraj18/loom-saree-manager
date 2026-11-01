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

test("factory expenses need no loom and use the factory categories", async () => {
  const f = (body = {}) => a.post("/api/expenses", { scope: "factory", amount: 500, ...body });
  assert.equal((await f({ kind: "bogus" })).status, 400, "unknown category");
  assert.equal((await f({ kind: "spares" })).status, 400, "loom categories are not factory categories");
  const r = await f({ kind: "rent", vendor: "Landlord", note: "Nov" });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.scope, r.body.loomId, r.body.loomName, r.body.label, r.body.vendor], ["factory", null, "", "Rent", "Landlord"]);
  // a loom expense still needs a loom, and old entries without a scope read as loom
  assert.equal((await a.post("/api/expenses", { kind: "maintenance", amount: 5 })).status, 400);
  assert.equal((await add({ kind: "maintenance" })).body.scope, "loom");
  const log = (await dataOf(a)).activity.find(x => x.type === "expense");
  assert.match(log.text, /Expense added: Maintenance/);
  assert.match((await dataOf(a)).activity.find(x => /Rent/.test(x.text)).text, /Rent ₹500 for the factory/);
});

test("own expense categories: add per section, use them, rename-proof label, and remove when unused", async () => {
  const cat = async (name, scope) => a.post("/api/expense-categories", { name, scope });
  assert.equal((await cat("", "factory")).status, 400, "name needed");
  assert.equal((await cat("Packing", "nowhere")).status, 400, "section needed");
  assert.equal((await cat("rent", "factory")).status, 409, "built-in names are taken");
  const packing = (await cat("Packing", "factory")).body;
  assert.equal((await cat("packing", "factory")).status, 409, "unique within the section");
  const loomCat = (await cat("Packing", "loom")).body;
  assert.notEqual(packing.id, loomCat.id, "the same name can exist in the other section");
  // used on a factory expense (and refused on a loom expense)
  const ok = await a.post("/api/expenses", { scope: "factory", kind: packing.id, amount: 90 });
  assert.equal(ok.status, 201);
  assert.deepEqual([ok.body.kind, ok.body.label], [packing.id, "Packing"]);
  assert.equal((await a.post("/api/expenses", { scope: "loom", loomId: loom.id, kind: packing.id, amount: 1 })).status, 400, "factory category on a loom expense");
  assert.equal((await add({ kind: loomCat.id, item: "tape" })).status, 201, "the loom copy works on a loom expense");
  // removal
  assert.equal((await a.del(`/api/expense-categories/${packing.id}`)).status, 409, "in use");
  await a.del(`/api/expenses/${ok.body.id}`);
  assert.equal((await a.del(`/api/expense-categories/${packing.id}`)).status, 200);
  assert.equal((await a.del(`/api/expense-categories/${packing.id}`)).status, 404);
  assert.ok((await dataOf(a)).expenseCategories.every(c => c.id !== packing.id));
});

test("expense categories work in every factory type", async () => {
  const job = await app.newFactory({ modules: { type: "job", process: true } });
  assert.equal((await job.api.post("/api/expense-categories", { name: "X", scope: "factory" })).status, 201);
});
