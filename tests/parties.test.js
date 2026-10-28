const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startApp, runningLoom, dispatch, dataOf } = require("./helpers");

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

// Stock + Wages factory (sarees are stock straight after dispatch) with 20 sarees in stock, two designs and a party.
async function partyFactory() {
  const f = await app.newFactory({ modules: { stock: true, wages: true } });
  const a = f.api;
  const { loom } = await runningLoom(a, { meters: 1000 });
  await dispatch(a, loom.id, 20);
  const d1 = (await a.post("/api/designs", { number: "D-101", name: "Mango", rate: 100 })).body;
  const d2 = (await a.post("/api/designs", { number: "D-202", rate: 100 })).body;
  const party = (await a.post("/api/clients", { name: "Sri Silks", address: "Salem" })).body;
  return { ...f, a, loom, d1, d2, party };
}
const give = (p, qty, extra = {}) => p.a.post("/api/stock/move", { from: "stock", to: "dispatched", qty, clientId: p.party.id, ...extra });
const back = (p, qty, extra = {}) => p.a.post("/api/stock/move", { from: "dispatched", to: "stock", qty, clientId: p.party.id, ...extra });

test("party: name required, unique; address kept", async () => {
  const f = await app.newFactory({ modules: { stock: true, wages: true } });
  assert.equal((await f.api.post("/api/clients", { name: "" })).status, 400);
  const c = await f.api.post("/api/clients", { name: "Kumar Textiles", address: "Erode" });
  assert.equal(c.status, 201);
  assert.equal(c.body.address, "Erode");
  assert.equal((await f.api.post("/api/clients", { name: "kumar textiles" })).status, 409);
});

test("editing a party: rename, address and rates by design; validation", async () => {
  const p = await partyFactory();
  const put = b => p.a.put(`/api/clients/${p.party.id}`, { name: "Sri Silks", ...b });
  assert.equal((await p.a.put(`/api/clients/${p.party.id}`, { name: "" })).status, 400);
  assert.equal((await p.a.put("/api/clients/missing", { name: "X" })).status, 404);
  assert.equal((await put({ rates: { [p.d1.id]: -5 } })).status, 400);
  assert.equal((await put({ rates: { [p.d1.id]: "abc" } })).status, 400);
  const ok = await put({ address: "New", rates: { [p.d1.id]: 450, [p.d2.id]: "", nope: 99 } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.rates, { [p.d1.id]: 450 }, "blank and unknown designs dropped");
  // rates only change when sent
  assert.deepEqual((await p.a.put(`/api/clients/${p.party.id}`, { name: "Sri Silks" })).body.rates, { [p.d1.id]: 450 });
  const other = (await p.a.post("/api/clients", { name: "Other" })).body;
  assert.equal((await p.a.put(`/api/clients/${other.id}`, { name: "sri silks" })).status, 409);
  assert.ok((await dataOf(p.a)).activity.some(e => e.type === "party" && /rates\/changes: .*D-101 — → ₹450/.test(e.text)), "rate change is logged");
});

test("a delivery can name a design: it is priced with the party's rate", async () => {
  const p = await partyFactory();
  await p.a.put(`/api/clients/${p.party.id}`, { name: "Sri Silks", rates: { [p.d1.id]: 450 } });
  const r = await give(p, 4, { designId: p.d1.id });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.move.designNo, r.body.move.rate, r.body.move.amount], ["D-101", 450, 1800]);
  assert.equal((await give(p, 1, { designId: p.d2.id })).status, 400, "no rate for D-202");
  assert.equal((await give(p, 1, { designId: "nope" })).status, 400);
  const plain = await give(p, 1);
  assert.equal(plain.status, 201);
  assert.equal(plain.body.move.amount, undefined);
  assert.match((await dataOf(p.a)).activity.find(e => e.type === "delivery").text, /D-101|delivered to/);
});

test("the rate is saved on the delivery: later rate changes do not alter it", async () => {
  const p = await partyFactory();
  await p.a.put(`/api/clients/${p.party.id}`, { name: "Sri Silks", rates: { [p.d1.id]: 450 } });
  const m = (await give(p, 2, { designId: p.d1.id })).body.move;
  await p.a.put(`/api/clients/${p.party.id}`, { name: "Sri Silks", rates: { [p.d1.id]: 900 } });
  const stored = (await dataOf(p.a)).stockMoves.find(x => x.id === m.id);
  assert.deepEqual([stored.rate, stored.amount], [450, 900], "still 2 × ₹450, not 2 × ₹900");
});

test("party return: priced at the party's rate, limited to what the party holds", async () => {
  const p = await partyFactory();
  await p.a.put(`/api/clients/${p.party.id}`, { name: "Sri Silks", rates: { [p.d1.id]: 450 } });
  await give(p, 5, { designId: p.d1.id });
  assert.equal((await back(p, 6)).status, 400);
  const r = await back(p, 1, { designId: p.d1.id });
  assert.equal(r.status, 201);
  assert.equal(r.body.move.amount, 450);
  assert.equal((await back(p, 1, { designId: p.d2.id })).status, 400, "no rate");
});

async function payment(p, body) { return p.a.post(`/api/clients/${p.party.id}/payments`, body); }

test("payments: amount > 0, valid date, mode; balance before/after", async () => {
  const p = await partyFactory();
  await p.a.put(`/api/clients/${p.party.id}`, { name: "Sri Silks", rates: { [p.d1.id]: 450 } });
  await give(p, 10, { designId: p.d1.id });   // billed 4500
  await back(p, 1, { designId: p.d1.id });    // credit 450 -> due 4050
  assert.equal((await payment(p, { amount: 0 })).status, 400);
  assert.equal((await payment(p, { amount: "x" })).status, 400);
  assert.equal((await payment(p, { amount: 10, date: "2026-13-45" })).status, 400);
  assert.equal((await p.a.post("/api/clients/missing/payments", { amount: 5 })).status, 404);
  const part = await payment(p, { amount: 1000, mode: "UPI", note: "part", date: "2026-10-01" });
  assert.equal(part.status, 201);
  assert.deepEqual([part.body.balanceBefore, part.body.balanceAfter, part.body.settled, part.body.mode, part.body.date], [4050, 3050, false, "UPI", "2026-10-01"]);
  assert.equal((await payment(p, { amount: 5, mode: "Barter" })).body.mode, "Cash", "unknown mode falls back to Cash");
});

test("settling the full balance marks the payment settled; removing a payment restores the balance", async () => {
  const p = await partyFactory();
  await p.a.put(`/api/clients/${p.party.id}`, { name: "Sri Silks", rates: { [p.d1.id]: 100 } });
  await give(p, 10, { designId: p.d1.id }); // 1000
  await payment(p, { amount: 400 });
  const last = await payment(p, { amount: 600 });
  assert.equal(last.body.balanceAfter, 0);
  assert.equal(last.body.settled, true);
  assert.equal((await p.a.del(`/api/clients/${p.party.id}/payments/${last.body.id}`)).status, 200);
  const again = await payment(p, { amount: 600 });
  assert.equal(again.body.balanceBefore, 600, "balance came back after the removal");
  assert.equal((await p.a.del(`/api/clients/${p.party.id}/payments/missing`)).status, 404);
});

test("an overpayment shows as a negative balance (advance)", async () => {
  const p = await partyFactory();
  await p.a.put(`/api/clients/${p.party.id}`, { name: "Sri Silks", rates: { [p.d1.id]: 100 } });
  await give(p, 1, { designId: p.d1.id });
  const r = await payment(p, { amount: 250 });
  assert.equal(r.body.balanceAfter, -150);
});

test("unpriced deliveries are not billed", async () => {
  const p = await partyFactory();
  await give(p, 5);
  const r = await payment(p, { amount: 10 });
  assert.equal(r.body.balanceBefore, 0);
  assert.equal(r.body.balanceAfter, -10);
});

test("payments and party edits are logged", async () => {
  const p = await partyFactory();
  await p.a.put(`/api/clients/${p.party.id}`, { name: "Sri Silks", rates: { [p.d1.id]: 100 } });
  await give(p, 2, { designId: p.d1.id });
  await payment(p, { amount: 200, mode: "Cash" });
  const log = (await dataOf(p.a)).activity.map(e => e.text);
  assert.ok(log.some(t => /₹200 received from Sri Silks \(Cash\).*settled/.test(t)));
});

test("a party with deliveries or payments cannot be removed; an unused party can", async () => {
  const p = await partyFactory();
  const unused = (await p.a.post("/api/clients", { name: "Unused" })).body;
  assert.equal((await p.a.del(`/api/clients/${unused.id}`)).status, 200);
  assert.equal((await p.a.del(`/api/clients/${unused.id}`)).status, 404);
  await give(p, 1);
  assert.equal((await p.a.del(`/api/clients/${p.party.id}`)).status, 409);
  const onlyPaid = (await p.a.post("/api/clients", { name: "OnlyPaid" })).body;
  await p.a.post(`/api/clients/${onlyPaid.id}/payments`, { amount: 5 });
  assert.equal((await p.a.del(`/api/clients/${onlyPaid.id}`)).status, 409);
});

test("removing a party is admin-only", async () => {
  const p = await partyFactory();
  await app.adminRaw.post("/api/admin/users", { username: "partyuser", password: "pw123", role: "user", factoryIds: [p.id] });
  const { token } = await app.login("partyuser", "pw123");
  const u = app.api(token, p.id);
  const c = (await u.post("/api/clients", { name: "ByUser" })).body;
  assert.equal((await u.del(`/api/clients/${c.id}`)).status, 403);
  assert.equal((await u.put(`/api/clients/${c.id}`, { name: "ByUser2" })).status, 200, "users can edit parties");
  assert.equal((await u.post(`/api/clients/${c.id}/payments`, { amount: 10 })).status, 201, "and record payments");
});

test("Stock only: parties work, but design rates are not offered (no designs)", async () => {
  const f = await app.newFactory({ modules: { stock: true, wages: false } });
  const c = (await f.api.post("/api/clients", { name: "Plain" })).body;
  assert.equal((await f.api.put(`/api/clients/${c.id}`, { name: "Plain", rates: { x: 5 } })).status, 200);
  assert.deepEqual((await dataOf(f.api)).clients[0].rates, {});
});
