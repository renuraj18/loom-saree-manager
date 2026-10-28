const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startApp, runningLoom, dispatch, dataOf } = require("./helpers");

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

// Stock only keeps the full Process flow: sent -> godown -> process -> folding -> stock.
async function stockFactory() {
  const f = await app.newFactory({ modules: { stock: true, wages: false } });
  const { warp, loom } = await runningLoom(f.api, { meters: 400 });
  const party = (await f.api.post("/api/clients", { name: "Party A" })).body;
  return { ...f, warp, loom, party, a: f.api };
}
const move = (a, body) => a.post("/api/stock/move", body);
// Reads the pooled/warp ledger from the last successful move response.
const ledger = r => r.body.pool;

test("dispatched sarees start in 'sent'; receive at godown is limited to what was sent", async () => {
  const s = await stockFactory();
  await dispatch(s.a, s.loom.id, 10);
  assert.equal((await move(s.a, { warpId: s.warp.id, from: "sent", to: "delivered", qty: 11 })).status, 400);
  const r = await move(s.a, { warpId: s.warp.id, from: "sent", to: "delivered", qty: 10 });
  assert.equal(r.status, 201);
  assert.equal(r.body.stock.sent, 0);
  assert.equal(r.body.stock.delivered, 10);
});

test("moves that are not part of the flow are refused", async () => {
  const s = await stockFactory();
  await dispatch(s.a, s.loom.id, 5);
  assert.equal((await move(s.a, { warpId: s.warp.id, from: "sent", to: "stock", qty: 1 })).status, 400);
  assert.equal((await move(s.a, { from: "lot", to: "stock", qty: 1 })).status, 400, "lot has no outgoing move");
  assert.equal((await move(s.a, { from: "stock", to: "dispatched", qty: 0, clientId: s.party.id })).status, 400);
  assert.equal((await move(s.a, { from: "stock", to: "dispatched", qty: 1.5, clientId: s.party.id })).status, 400);
});

test("checking at the godown splits into process, greese and damage; the total cannot exceed the godown", async () => {
  const s = await stockFactory();
  await dispatch(s.a, s.loom.id, 10);
  await move(s.a, { warpId: s.warp.id, from: "sent", to: "delivered", qty: 10 });
  const sort = body => s.a.post("/api/stock/sort", { warpId: s.warp.id, ...body });
  assert.equal((await sort({ from: "delivered" })).status, 400, "needs at least one count");
  assert.equal((await sort({ from: "delivered", process: 8, mai: 2, damage: 1 })).status, 400, "11 > 10");
  assert.equal((await sort({ from: "delivered", process: -1 })).status, 400);
  const ok = await sort({ from: "delivered", process: 7, mai: 2, damage: 1 });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.stock.delivered, 0);
  assert.equal(ok.body.stock.process, 7);
  assert.equal(ok.body.stock.mai, 2);
  assert.equal(ok.body.stock.damage, 1);
});

test("greese / damage found while in process come off the process count", async () => {
  const s = await stockFactory();
  await dispatch(s.a, s.loom.id, 10);
  await move(s.a, { warpId: s.warp.id, from: "sent", to: "delivered", qty: 10 });
  await s.a.post("/api/stock/sort", { warpId: s.warp.id, from: "delivered", process: 10 });
  const r = await s.a.post("/api/stock/sort", { warpId: s.warp.id, from: "process", mai: 2, damage: 1 });
  assert.equal(r.status, 201);
  assert.equal(r.body.stock.process, 7);
  assert.equal(r.body.stock.mai, 2);
  assert.equal(r.body.stock.damage, 1);
  assert.equal((await s.a.post("/api/stock/sort", { warpId: s.warp.id, from: "process", mai: 20 })).status, 400);
  assert.equal((await s.a.post("/api/stock/sort", { warpId: s.warp.id, from: "process", process: 1 })).status, 400, "no such field: nothing entered");
});

test("process -> folding -> add to stock (split into stock, mai, lot, damage)", async () => {
  const s = await stockFactory();
  await dispatch(s.a, s.loom.id, 10);
  await move(s.a, { warpId: s.warp.id, from: "sent", to: "delivered", qty: 10 });
  await s.a.post("/api/stock/sort", { warpId: s.warp.id, from: "delivered", process: 10 });
  assert.equal((await move(s.a, { warpId: s.warp.id, from: "process", to: "folding", qty: 11 })).status, 400);
  assert.equal((await move(s.a, { warpId: s.warp.id, from: "process", to: "folding", qty: 10 })).status, 201);
  const r = await s.a.post("/api/stock/sort", { warpId: s.warp.id, from: "folding", stock: 6, mai: 1, lot: 2, damage: 1 });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.pool.stock, r.body.pool.mai, r.body.pool.lot, r.body.pool.damage], [6, 1, 2, 1]);
  assert.equal(r.body.stock.folding, 0);
});

// Puts `n` sarees in stock for a fresh factory.
async function withStock(n) {
  const s = await stockFactory();
  await dispatch(s.a, s.loom.id, n);
  await move(s.a, { warpId: s.warp.id, from: "sent", to: "delivered", qty: n });
  await s.a.post("/api/stock/sort", { warpId: s.warp.id, from: "delivered", process: n });
  await move(s.a, { warpId: s.warp.id, from: "process", to: "folding", qty: n });
  await s.a.post("/api/stock/sort", { warpId: s.warp.id, from: "folding", stock: n });
  return s;
}

test("delivery to a party needs a party and is limited to stock; returns are limited to what the party holds", async () => {
  const s = await withStock(10);
  assert.equal((await move(s.a, { from: "stock", to: "dispatched", qty: 2 })).status, 400, "no party");
  assert.equal((await move(s.a, { from: "stock", to: "dispatched", qty: 11, clientId: s.party.id })).status, 400);
  const give = await move(s.a, { from: "stock", to: "dispatched", qty: 6, clientId: s.party.id, lrNumber: "LR-1" });
  assert.equal(give.status, 201);
  assert.equal(ledger(give).stock, 4);
  assert.equal(ledger(give).dispatched, 6);
  assert.equal((await move(s.a, { from: "dispatched", to: "stock", qty: 7, clientId: s.party.id })).status, 400);
  const back = await move(s.a, { from: "dispatched", to: "stock", qty: 2, clientId: s.party.id });
  assert.equal(back.status, 201);
  assert.equal(ledger(back).stock, 6);
  assert.equal(ledger(back).dispatched, 4);
});

test("damage return and returning damaged sarees to the loom owner", async () => {
  const s = await withStock(10);
  assert.equal((await move(s.a, { from: "stock", to: "damage", qty: 11 })).status, 400);
  const d = await move(s.a, { from: "stock", to: "damage", qty: 3, note: "torn" });
  assert.equal(ledger(d).damage, 3);
  const owner = await move(s.a, { from: "damage", to: "returned", qty: 2 });
  assert.equal(owner.status, 201);
  assert.equal(owner.body.move.ownerName, "Owner");
  assert.equal(ledger(owner).returned, 2);
  assert.equal((await move(s.a, { from: "damage", to: "returned", qty: 5 })).status, 400);
});

test("cleaning: each send is a batch; a return must name its batch and stay within it", async () => {
  const s = await withStock(10);
  await s.a.post("/api/stock/sort", { warpId: s.warp.id, from: "folding", stock: 0 }).catch(() => {});
  // put 5 in mai via adjust
  assert.equal((await s.a.post("/api/stock/adjust", { bucket: "mai", count: 5 })).status, 201);
  assert.equal((await move(s.a, { from: "mai", to: "cleaning", qty: 6 })).status, 400);
  const b1 = (await move(s.a, { from: "mai", to: "cleaning", qty: 3, note: "Cleaner A" })).body.move;
  const b2 = (await move(s.a, { from: "mai", to: "cleaning", qty: 2, note: "Cleaner B" })).body.move;
  assert.equal((await move(s.a, { from: "cleaning", to: "stock", qty: 1 })).status, 400, "batch required");
  assert.equal((await move(s.a, { from: "cleaning", to: "stock", qty: 4, batchId: b1.id })).status, 400, "batch only has 3");
  const back = await move(s.a, { from: "cleaning", to: "stock", qty: 3, batchId: b1.id });
  assert.equal(back.status, 201);
  assert.equal(ledger(back).cleaning, 2);
  assert.equal(ledger(back).stock, 13);
  assert.equal((await move(s.a, { from: "cleaning", to: "stock", qty: 1, batchId: b1.id })).status, 400, "batch is done");
  assert.equal((await move(s.a, { from: "cleaning", to: "stock", qty: 2, batchId: b2.id })).status, 201);
});

test("adjust sets the pooled count and records the difference; validation", async () => {
  const s = await withStock(4);
  assert.equal((await s.a.post("/api/stock/adjust", { bucket: "stock", count: 4 })).status, 400, "already 4");
  assert.equal((await s.a.post("/api/stock/adjust", { bucket: "stock", count: -1 })).status, 400);
  assert.equal((await s.a.post("/api/stock/adjust", { bucket: "stock", count: 2.5 })).status, 400);
  assert.equal((await s.a.post("/api/stock/adjust", { bucket: "dispatched", count: 1 })).status, 400, "not adjustable");
  const r = await s.a.post("/api/stock/adjust", { bucket: "stock", count: 9, note: "physical count" });
  assert.equal(r.status, 201);
  assert.equal(r.body.pool.stock, 9);
  assert.equal(r.body.move.qty, 5);
  const down = await s.a.post("/api/stock/adjust", { bucket: "lot", count: 3 });
  assert.equal(down.body.pool.lot, 3);
});

test("per-warp stages can be corrected with adjust (godown, process, folding)", async () => {
  const s = await stockFactory();
  await dispatch(s.a, s.loom.id, 5);
  const r = await s.a.post("/api/stock/adjust", { warpId: s.warp.id, bucket: "process", count: 3 });
  assert.equal(r.status, 201);
  assert.equal(r.body.pool.process, 3);
  assert.equal(r.body.move.warpId, s.warp.id);
  assert.equal((await s.a.post("/api/stock/adjust", { warpId: s.warp.id, bucket: "stock", count: 3 })).status, 400, "pooled bucket, not per warp");
});

test("stock is pooled across warps", async () => {
  const s = await withStock(5);
  const w2 = await runningLoom(s.a, { name: "L2", warpName: "W2", meters: 100 });
  await dispatch(s.a, w2.loom.id, 3);
  await move(s.a, { warpId: w2.warp.id, from: "sent", to: "delivered", qty: 3 });
  await s.a.post("/api/stock/sort", { warpId: w2.warp.id, from: "delivered", process: 3 });
  await move(s.a, { warpId: w2.warp.id, from: "process", to: "folding", qty: 3 });
  const r = await s.a.post("/api/stock/sort", { warpId: w2.warp.id, from: "folding", stock: 3 });
  assert.equal(r.body.pool.stock, 8);
  assert.equal((await move(s.a, { from: "stock", to: "dispatched", qty: 8, clientId: s.party.id })).status, 201);
});

test("every stock change is logged", async () => {
  const s = await withStock(3);
  await move(s.a, { from: "stock", to: "dispatched", qty: 1, clientId: s.party.id });
  const log = (await dataOf(s.a)).activity;
  assert.ok(log.some(e => e.type === "process" && /added to stock/.test(e.text)));
  assert.ok(log.some(e => e.type === "delivery" && /delivered to Party A/.test(e.text)));
});

test("dispatched sarees can still be edited while they are in 'sent'", async () => {
  const s = await stockFactory();
  const d = (await dispatch(s.a, s.loom.id, 6)).body.delivery;
  assert.equal((await s.a.put(`/api/deliveries/${d.id}`, { sarees: 4 })).status, 200);
  await move(s.a, { warpId: s.warp.id, from: "sent", to: "delivered", qty: 4 });
  // 4 are now at the godown; going below what has moved on is refused
  assert.equal((await s.a.put(`/api/deliveries/${d.id}`, { sarees: 2 })).status, 409);
});
