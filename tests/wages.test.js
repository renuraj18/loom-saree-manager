const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startApp, runningLoom, dispatch, dataOf } = require("./helpers");

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

const base = { location: "Salem", ownerName: "Owner" };
// A Stock + Wages factory with a running loom, design D1 (₹100/saree) and weaver Ravi on the loom.
async function wagesFactory(extra = {}) {
  const f = await app.newFactory({ modules: { stock: true, wages: true }, ...extra });
  const a = f.api;
  const { warp, loom } = await runningLoom(a, { meters: 1000 });
  const design = (await a.post("/api/designs", { number: "D1", name: "Mango", rate: 100 })).body;
  const staff = (await a.post("/api/staff", { name: "Ravi", phone: "98765" })).body;
  await a.post(`/api/looms/${loom.id}/setup`, { designId: design.id, staffId: staff.id });
  return { ...f, a, warp, loom, design, staff };
}
const settle = (a, body = {}) => a.post("/api/wages/settle", body);

test("design validation: number, wage > 0, unique number, weaving details", async () => {
  const f = await app.newFactory({ modules: { stock: true, wages: true } });
  const post = b => f.api.post("/api/designs", b);
  assert.equal((await post({ number: "", rate: 10 })).status, 400);
  assert.equal((await post({ number: "A", rate: 0 })).status, 400);
  assert.equal((await post({ number: "A", rate: 100 })).status, 201);
  assert.equal((await post({ number: "a", rate: 100 })).status, 409);
  assert.equal((await post({ number: "B", rate: 100, picks: 12.5 })).status, 400, "picks are whole");
  assert.equal((await post({ number: "B", rate: 100, timing: -1 })).status, 400);
  assert.equal((await post({ number: "B", rate: 100, pickCost: "x" })).status, 400);
  const ok = await post({ number: "C", rate: 100, picks: 2400, timing: 6.5, pickCost: 0.15 });
  assert.equal(ok.status, 201);
  assert.deepEqual([ok.body.picks, ok.body.timing, ok.body.pickCost], [2400, 6.5, 0.15]);
  const blank = (await post({ number: "D", rate: 100, picks: "" })).body;
  assert.equal(blank.picks, null);
});

test("editing a design logs what changed", async () => {
  const f = await app.newFactory({ modules: { stock: true, wages: true } });
  const d = (await f.api.post("/api/designs", { number: "E1", rate: 100, picks: 1000 })).body;
  const r = await f.api.put(`/api/designs/${d.id}`, { number: "E1", rate: 120, picks: "", timing: 7, pickCost: 0.2 });
  assert.equal(r.status, 200);
  const log = (await dataOf(f.api)).activity[0].text;
  assert.match(log, /wage ₹100 → ₹120/);
  assert.match(log, /picks 1000 → —/);
});

test("weaver validation: name required and unique", async () => {
  const f = await app.newFactory({ modules: { stock: true, wages: true } });
  assert.equal((await f.api.post("/api/staff", { name: "" })).status, 400);
  assert.equal((await f.api.post("/api/staff", { name: "Mani" })).status, 201);
  assert.equal((await f.api.post("/api/staff", { name: "mani" })).status, 409);
});

test("a weaver or design on a loom cannot be removed", async () => {
  const f = await wagesFactory();
  assert.equal((await app.api(app.token, f.id).del(`/api/staff/${f.staff.id}`)).status, 409);
  assert.equal((await app.api(app.token, f.id).del(`/api/designs/${f.design.id}`)).status, 409);
});

test("a dispatch earns sarees × the design rate for the loom's weaver (snapshot)", async () => {
  const f = await wagesFactory();
  const r = await dispatch(f.a, f.loom.id, 10);
  assert.equal(r.status, 201);
  const d = r.body.delivery;
  assert.deepEqual([d.wage, d.rate, d.staffName, d.designNo], [1000, 100, "Ravi", "D1"]);
  // later rate changes do not touch wages already earned
  await f.a.put(`/api/designs/${f.design.id}`, { number: "D1", rate: 500 });
  const stored = (await dataOf(f.a)).deliveries.find(x => x.id === d.id);
  assert.equal(stored.wage, 1000);
  assert.equal((await dispatch(f.a, f.loom.id, 1)).body.delivery.wage, 500);
});

test("triple width: every saree is paid, though meters are a third", async () => {
  const f = await app.newFactory({ modules: { stock: true, wages: true } });
  const { loom } = await runningLoom(f.api, { widthType: "triple", meters: 300 });
  const design = (await f.api.post("/api/designs", { number: "T1", rate: 50 })).body;
  const staff = (await f.api.post("/api/staff", { name: "W" })).body;
  await f.api.post(`/api/looms/${loom.id}/setup`, { designId: design.id, staffId: staff.id });
  const r = await dispatch(f.api, loom.id, 6);
  assert.equal(r.body.delivery.wage, 300);
  assert.equal(r.body.delivery.metersReduced, 12.6);
});

test("no wage is recorded unless both a design and a weaver are set", async () => {
  const f = await app.newFactory({ modules: { stock: true, wages: true } });
  const { loom } = await runningLoom(f.api);
  assert.equal((await dispatch(f.api, loom.id, 1)).body.delivery.wage, undefined);
  const staff = (await f.api.post("/api/staff", { name: "OnlyStaff" })).body;
  await f.api.post(`/api/looms/${loom.id}/setup`, { staffId: staff.id });
  assert.equal((await dispatch(f.api, loom.id, 1)).body.delivery.wage, undefined);
});

test("a loom can have several designs; a dispatch picks one and the loom switches to it", async () => {
  const f = await wagesFactory();
  const d2 = (await f.a.post("/api/designs", { number: "D2", rate: 300 })).body;
  const setup = await f.a.post(`/api/looms/${f.loom.id}/setup`, { designIds: [f.design.id, d2.id], designId: f.design.id, staffId: f.staff.id });
  assert.equal(setup.status, 200);
  assert.deepEqual(setup.body.designIds, [f.design.id, d2.id]);
  assert.equal((await dispatch(f.a, f.loom.id, 2)).body.delivery.wage, 200, "default design");
  const r = await dispatch(f.a, f.loom.id, 2, { designId: d2.id });
  assert.equal(r.body.delivery.wage, 600);
  assert.equal((await dataOf(f.a)).looms.find(l => l.id === f.loom.id).designId, d2.id);
  assert.equal((await dispatch(f.a, f.loom.id, 1, { designId: "nope" })).status, 400, "not one of the loom's designs");
  // the weaving-now design must be one of the loom's designs
  assert.equal((await f.a.post(`/api/looms/${f.loom.id}/setup`, { designIds: [f.design.id], designId: d2.id })).status, 400);
  // a design on any loom cannot be removed
  assert.equal((await app.api(app.token, f.id).del(`/api/designs/${d2.id}`)).status, 409);
});

test("the older single-design call still works", async () => {
  const f = await wagesFactory();
  const r = await f.a.post(`/api/looms/${f.loom.id}/setup`, { designId: f.design.id, staffId: f.staff.id });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.designIds, [f.design.id]);
  assert.equal((await f.a.post(`/api/looms/${f.loom.id}/setup`, { designId: "missing" })).status, 404);
});

test("damage deductions: validation, amounts, and removal while unpaid", async () => {
  const f = await wagesFactory();
  const post = b => f.a.post("/api/wages/deductions", b);
  assert.equal((await post({ minorSarees: 1, minorRate: 10 })).status, 400, "weaver required");
  assert.equal((await post({ staffId: f.staff.id })).status, 400, "nothing entered");
  assert.equal((await post({ staffId: f.staff.id, minorSarees: 2 })).status, 400, "rate required");
  assert.equal((await post({ staffId: f.staff.id, minorSarees: 1.5, minorRate: 10 })).status, 400);
  const ok = await post({ staffId: f.staff.id, minorSarees: 2, minorRate: 50, heavySarees: 1, heavyRate: 400, note: "torn" });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.amount, 500);
  assert.equal(ok.body.items.length, 2);
  assert.equal((await f.a.del(`/api/wages/deductions/${ok.body.id}`)).status, 200);
  assert.equal((await f.a.del(`/api/wages/deductions/${ok.body.id}`)).status, 404);
});

test("settling pays earnings minus deductions, stamps the records, and starts a new period", async () => {
  const f = await wagesFactory();
  await dispatch(f.a, f.loom.id, 10); // 1000
  await dispatch(f.a, f.loom.id, 5);  // 500
  await f.a.post("/api/wages/deductions", { staffId: f.staff.id, minorSarees: 2, minorRate: 100 }); // 200
  const r = await settle(f.a, { note: "week 1" });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.earned, r.body.deducted, r.body.total, r.body.sarees], [1500, 200, 1300, 15]);
  assert.equal(r.body.lines[0].net, 1300);
  assert.equal(r.body.lines[0].items[0].sarees, 15);
  const d = await dataOf(f.a);
  assert.ok(d.deliveries.every(x => x.payoutId === r.body.id));
  assert.equal(d.wagePayouts.length, 1);
  assert.equal((await settle(f.a)).status, 400, "nothing left to settle");
  // the next dispatch starts a fresh period
  await dispatch(f.a, f.loom.id, 1);
  assert.equal((await settle(f.a)).body.total, 100);
});

test("settled dispatches can no longer change their sarees", async () => {
  const f = await wagesFactory();
  const d = (await dispatch(f.a, f.loom.id, 4)).body.delivery;
  assert.equal((await f.a.put(`/api/deliveries/${d.id}`, { sarees: 5 })).status, 200, "unpaid: wage follows");
  assert.equal((await dataOf(f.a)).deliveries[0].wage, 500);
  await settle(f.a);
  assert.equal((await f.a.put(`/api/deliveries/${d.id}`, { sarees: 6 })).status, 409);
});

test("settling only some weavers leaves the others' open periods", async () => {
  const f = await wagesFactory();
  const other = (await f.a.post("/api/staff", { name: "Kumar" })).body;
  const { loom: loom2 } = await runningLoom(f.a, { name: "L2", warpName: "W2", meters: 500 });
  await f.a.post(`/api/looms/${loom2.id}/setup`, { designId: f.design.id, staffId: other.id });
  await dispatch(f.a, f.loom.id, 3);
  await dispatch(f.a, loom2.id, 2);
  assert.equal((await settle(f.a, { staffIds: [] })).status, 400);
  const r = await settle(f.a, { staffIds: [f.staff.id] });
  assert.equal(r.status, 201);
  assert.equal(r.body.partial, true);
  assert.equal(r.body.total, 300);
  assert.equal((await settle(f.a)).body.total, 200, "Kumar's wages still open");
});

test("deductions bigger than earnings pay 0 and carry the rest into the next period", async () => {
  const f = await wagesFactory();
  await dispatch(f.a, f.loom.id, 1); // 100
  await f.a.post("/api/wages/deductions", { staffId: f.staff.id, heavySarees: 1, heavyRate: 350 });
  const r = await settle(f.a);
  assert.equal(r.body.total, 0);
  assert.equal(r.body.carried, 250);
  const carry = (await dataOf(f.a)).wageDeductions.find(x => x.carry && !x.payoutId);
  assert.equal(carry.amount, 250);
  assert.equal((await settle(f.a)).status, 400, "a period with only a carry cannot be settled");
  await dispatch(f.a, f.loom.id, 5); // 500 - 250 carried
  assert.equal((await settle(f.a)).body.total, 250);
});

test("other deductions (e.g. an advance) can be added while settling", async () => {
  const f = await wagesFactory();
  await dispatch(f.a, f.loom.id, 10);
  assert.equal((await settle(f.a, { adjustments: { [f.staff.id]: { amount: -5 } } })).status, 400);
  const r = await settle(f.a, { adjustments: { [f.staff.id]: { amount: 300, note: "Advance" } } });
  assert.equal(r.status, 201);
  assert.equal(r.body.total, 700);
  assert.equal(r.body.lines[0].deductions[0].label, "Advance");
});

test("correcting unpaid wages: sarees and rate on a dispatch, and deductions", async () => {
  const f = await wagesFactory();
  const d = (await dispatch(f.a, f.loom.id, 10)).body.delivery;
  const ded = (await f.a.post("/api/wages/deductions", { staffId: f.staff.id, minorSarees: 2, minorRate: 50 })).body;
  const edit = await f.a.post("/api/wages/edit", { staffId: f.staff.id,
    dispatches: [{ id: d.id, sarees: 8, rate: 120 }], deductions: [{ id: ded.id, items: [{ sarees: 1, rate: 50 }] }] });
  assert.equal(edit.status, 200);
  const data = await dataOf(f.a);
  const stored = data.deliveries.find(x => x.id === d.id);
  assert.deepEqual([stored.wage, stored.wageSarees, stored.sarees], [960, 8, 10], "production count unchanged");
  assert.equal(data.wageDeductions.find(x => x.id === ded.id).amount, 50);
  assert.equal((await f.a.post("/api/wages/edit", { staffId: f.staff.id, dispatches: [{ id: d.id, sarees: -1, rate: 1 }] })).status, 400);
  await settle(f.a);
  assert.equal((await f.a.post("/api/wages/edit", { staffId: f.staff.id, dispatches: [{ id: d.id, sarees: 1, rate: 1 }] })).status, 400, "settled records can't be edited");
});

// ---------------- shift mode ----------------
async function shiftFactory(shifts) {
  const f = await wagesFactory();
  const r = await app.adminRaw.put(`/api/admin/factories/${f.id}`, { name: f.factory.name, ...base, modules: { stock: true, wages: true },
    wageBasis: "shift", shifts: shifts || [{ name: "Day", start: "06:00", hours: 8, rate: 600 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return f;
}

test("shift mode: dispatches record the weaver and design but no per-saree wage", async () => {
  const f = await shiftFactory();
  const d = (await dispatch(f.a, f.loom.id, 10)).body.delivery;
  assert.equal(d.wage, undefined);
  assert.equal(d.rate, undefined);
  assert.equal(d.staffName, "Ravi");
  assert.equal(d.designNo, "D1");
});

test("shift entries: weaver, half shifts, > 0; wage = shifts × rate", async () => {
  const f = await shiftFactory();
  const post = b => f.a.post("/api/wages/shifts", b);
  assert.equal((await post({ shifts: 2 })).status, 400, "weaver required");
  assert.equal((await post({ staffId: f.staff.id, shifts: 0 })).status, 400);
  assert.equal((await post({ staffId: f.staff.id, shifts: 0.3 })).status, 400);
  assert.equal((await post({ staffId: f.staff.id, shifts: 101 })).status, 400);
  const ok = await post({ staffId: f.staff.id, shifts: 6.5, note: "week 1" });
  assert.equal(ok.status, 201);
  assert.deepEqual([ok.body.wage, ok.body.shiftRate, ok.body.shiftName], [3900, 600, "Day"]);
});

test("shift entries can be removed while unpaid, and settle like earnings", async () => {
  const f = await shiftFactory();
  const a1 = (await f.a.post("/api/wages/shifts", { staffId: f.staff.id, shifts: 2 })).body;
  await f.a.post("/api/wages/shifts", { staffId: f.staff.id, shifts: 4 });
  assert.equal((await f.a.del(`/api/wages/shifts/${a1.id}`)).status, 200);
  assert.equal((await f.a.del(`/api/wages/shifts/${a1.id}`)).status, 404);
  await f.a.post("/api/wages/deductions", { staffId: f.staff.id, minorSarees: 1, minorRate: 100 });
  const r = await settle(f.a);
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.earned, r.body.deducted, r.body.total, r.body.sarees], [2400, 100, 2300, 0]);
  assert.equal(r.body.lines[0].shifts, 4);
  assert.deepEqual([r.body.lines[0].items[0].shift, r.body.lines[0].items[0].designNo, r.body.lines[0].items[0].shifts], [true, "Day", 4]);
  const entry = (await dataOf(f.a)).wageShifts[0];
  assert.ok(entry.payoutId);
  assert.equal((await f.a.del(`/api/wages/shifts/${entry.id}`)).status, 409, "settled");
});

test("two shifts with their own rates: the shift must be chosen, and each is paid at its rate", async () => {
  const f = await shiftFactory([{ name: "Day", start: "06:00", hours: 8, rate: 600 }, { name: "Night", start: "18:00", hours: 8, rate: 700 }]);
  assert.equal((await f.a.post("/api/wages/shifts", { staffId: f.staff.id, shifts: 1 })).status, 400, "which shift?");
  assert.equal((await f.a.post("/api/wages/shifts", { staffId: f.staff.id, shifts: 1, shiftName: "Evening" })).status, 400);
  await f.a.post("/api/wages/shifts", { staffId: f.staff.id, shifts: 4, shiftName: "Day" });
  await f.a.post("/api/wages/shifts", { staffId: f.staff.id, shifts: 3, shiftName: "Night" });
  const r = await settle(f.a);
  assert.equal(r.body.total, 4500);
  const items = Object.fromEntries(r.body.lines[0].items.map(i => [i.designNo, [i.shifts, i.rate, i.amount]]));
  assert.deepEqual(items, { Day: [4, 600, 2400], Night: [3, 700, 2100] });
});

test("a shift entry keeps the rate it was entered at", async () => {
  const f = await shiftFactory();
  const e = (await f.a.post("/api/wages/shifts", { staffId: f.staff.id, shifts: 2 })).body;
  await app.adminRaw.put(`/api/admin/factories/${f.id}`, { name: f.factory.name, ...base, modules: { stock: true, wages: true },
    wageBasis: "shift", shifts: [{ name: "Day", start: "06:00", hours: 8, rate: 900 }] });
  const stored = (await dataOf(f.a)).wageShifts.find(x => x.id === e.id);
  assert.equal(stored.wage, 1200);
  assert.equal((await f.a.post("/api/wages/shifts", { staffId: f.staff.id, shifts: 1 })).body.wage, 900);
});

test("saree mode refuses shift entries; unpaid saree wages and shifts settle together after a switch", async () => {
  const f = await wagesFactory();
  assert.equal((await f.a.post("/api/wages/shifts", { staffId: f.staff.id, shifts: 1 })).status, 409);
  await dispatch(f.a, f.loom.id, 5); // 500 by saree
  await app.adminRaw.put(`/api/admin/factories/${f.id}`, { name: f.factory.name, ...base, modules: { stock: true, wages: true },
    wageBasis: "shift", shifts: [{ name: "Day", start: "06:00", hours: 8, rate: 600 }] });
  await f.a.post("/api/wages/shifts", { staffId: f.staff.id, shifts: 1 }); // 600
  const r = await settle(f.a);
  assert.equal(r.body.total, 1100);
  assert.equal(r.body.lines[0].items.length, 2);
});

test("the edit-wages screen only touches dispatches, never shift entries", async () => {
  const f = await shiftFactory();
  const e = (await f.a.post("/api/wages/shifts", { staffId: f.staff.id, shifts: 2 })).body;
  const r = await f.a.post("/api/wages/edit", { staffId: f.staff.id, dispatches: [{ id: e.id, sarees: 1, rate: 1 }] });
  assert.equal(r.status, 400);
});
