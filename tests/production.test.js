const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startApp, runningLoom, dispatch, dataOf } = require("./helpers");

let app, a;
before(async () => { app = await startApp(); a = app.admin; });
after(async () => { await app.stop(); });

const newWarp = (name, extra = {}) => a.post("/api/warps", { name, widthType: "single", meters: 100, bodyColor: "Red", borderColor: "Gold", ...extra });

test("warp validation: required fields, minimum one saree length, unique name", async () => {
  assert.equal((await a.post("/api/warps", { name: "", widthType: "single", meters: 100, bodyColor: "R", borderColor: "G" })).status, 400);
  assert.equal((await newWarp("BadWidth", { widthType: "double" })).status, 400);
  assert.equal((await newWarp("Short", { meters: 6.2 })).status, 400);
  assert.equal((await newWarp("Exact", { meters: 6.3 })).status, 201);
  assert.equal((await newWarp("Dup1")).status, 201);
  assert.equal((await newWarp("dup1")).status, 409);
});

test("bobbin validation mirrors warps", async () => {
  assert.equal((await a.post("/api/bobbins", { name: "B0", widthType: "single", meters: 3, color: "Red" })).status, 400);
  assert.equal((await a.post("/api/bobbins", { name: "B1", widthType: "single", meters: 100, color: "Red" })).status, 201);
  assert.equal((await a.post("/api/bobbins", { name: "b1", widthType: "single", meters: 100, color: "Red" })).status, 409);
});

test("loom needs only a number and width; names are unique", async () => {
  assert.equal((await a.post("/api/looms", { name: "", widthType: "single" })).status, 400);
  assert.equal((await a.post("/api/looms", { name: "LoomA", widthType: "wide" })).status, 400);
  assert.equal((await a.post("/api/looms", { name: "LoomA", widthType: "single" })).status, 201);
  assert.equal((await a.post("/api/looms", { name: "loomA", widthType: "single" })).status, 409);
});

test("warp lifecycle: ordered <-> ready, ready -> running -> ready, width must match", async () => {
  const w = (await newWarp("Life1")).body;
  const single = (await a.post("/api/looms", { name: "LifeS", widthType: "single" })).body;
  const triple = (await a.post("/api/looms", { name: "LifeT", widthType: "triple" })).body;
  assert.equal(w.status, "Ordered");
  assert.equal((await a.post(`/api/warps/${w.id}/move`, { to: "ready" })).status, 200);
  const wrong = await a.post(`/api/warps/${w.id}/move`, { to: "running", loomId: triple.id });
  assert.equal(wrong.status, 400, "single warp on a triple loom");
  const ok = await a.post(`/api/warps/${w.id}/move`, { to: "running", loomId: single.id });
  assert.equal(ok.status, 200);
  assert.equal((await dataOf(a)).warps.find(x => x.id === w.id).status, "In Use");
  // a second warp cannot go on the same loom
  const w2 = (await newWarp("Life2")).body;
  await a.post(`/api/warps/${w2.id}/move`, { to: "ready" });
  assert.equal((await a.post(`/api/warps/${w2.id}/move`, { to: "running", loomId: single.id })).status >= 400, true);
  // cannot discard while on a loom
  assert.equal((await a.post(`/api/warps/${w.id}/discard`, {})).status, 409);
  // back to ready frees the loom
  assert.equal((await a.post(`/api/warps/${w.id}/move`, { to: "ready" })).status, 200);
  assert.equal((await a.post(`/api/warps/${w2.id}/move`, { to: "running", loomId: single.id })).status, 200);
});

test("a warp that was woven cannot go back to ordered", async () => {
  const { warp, loom } = await runningLoom(a, { name: "BackL", warpName: "BackW" });
  await dispatch(a, loom.id, 1);
  await a.post(`/api/warps/${warp.id}/move`, { to: "ready" });
  const r = await a.post(`/api/warps/${warp.id}/move`, { to: "ordered" });
  assert.equal(r.status >= 400, true);
});

test("discard works for an idle warp and is final", async () => {
  const w = (await newWarp("Disc1")).body;
  assert.equal((await a.post(`/api/warps/${w.id}/discard`, { reason: "damaged" })).status, 200);
  assert.equal((await a.post(`/api/warps/${w.id}/discard`, {})).status, 409);
});

test("dispatch uses 6.3 m per saree and records the delivery", async () => {
  const { warp, loom } = await runningLoom(a, { name: "DL1", warpName: "DW1", meters: 100 });
  const r = await dispatch(a, loom.id, 10, { lrNumber: "LR-7" });
  assert.equal(r.status, 201);
  assert.equal(r.body.delivery.metersReduced, 63);
  assert.equal(r.body.delivery.lrNumber, "LR-7");
  assert.equal(r.body.warp.remainingMeters, 37);
  assert.equal((await dataOf(a)).looms.find(l => l.id === loom.id).wovenMeters, 63);
});

test("dispatch validation: positive whole sarees, enough warp, running loom", async () => {
  const { loom } = await runningLoom(a, { name: "DL2", warpName: "DW2", meters: 63 });
  assert.equal((await dispatch(a, loom.id, 0)).status, 400);
  assert.equal((await dispatch(a, loom.id, 1.5)).status, 400);
  assert.equal((await dispatch(a, loom.id, 11)).status, 400, "needs 69.3 m, has 63");
  assert.equal((await dispatch(a, "no-such-loom", 1)).status, 404);
  const idle = (await a.post("/api/looms", { name: "NoWarp", widthType: "single" })).body;
  assert.equal((await dispatch(a, idle.id, 1)).status, 400, "no warp on the loom");
});

test("triple width: sarees in multiples of 3, meters divided by 3", async () => {
  const { warp, loom } = await runningLoom(a, { name: "TL1", warpName: "TW1", widthType: "triple", meters: 100 });
  assert.equal((await dispatch(a, loom.id, 4)).status, 400);
  const r = await dispatch(a, loom.id, 6);
  assert.equal(r.status, 201);
  assert.equal(r.body.delivery.metersReduced, 12.6);
});

test("a warp with less than one saree left is completed and frees the loom", async () => {
  const { warp, loom } = await runningLoom(a, { name: "SP1", warpName: "SP-W", meters: 13 });
  const r = await dispatch(a, loom.id, 2); // 12.6 m used, 0.4 m left
  assert.equal(r.status, 201);
  assert.equal(r.body.warp.status, "Completed");
  assert.equal(r.body.warp.remainingMeters, 0.4);
  const d = await dataOf(a);
  assert.equal(d.looms.find(l => l.id === loom.id).warpId, null);
});

test("stopping a loom blocks dispatch until it is resumed", async () => {
  const { loom } = await runningLoom(a, { name: "ST1", warpName: "ST-W" });
  assert.equal((await a.post(`/api/looms/${loom.id}/stop`, { reason: "repair" })).status, 200);
  assert.equal((await a.post(`/api/looms/${loom.id}/stop`, {})).status, 409);
  assert.equal((await dispatch(a, loom.id, 1)).status, 409);
  assert.equal((await a.post(`/api/looms/${loom.id}/resume`, {})).status, 200);
  assert.equal((await dispatch(a, loom.id, 1)).status, 201);
});

test("a loom that needs a bobbin cannot dispatch without one; the bobbin shares the meters", async () => {
  const { loom } = await runningLoom(a, { name: "BL1", warpName: "BW1", meters: 200, needsBobbin: true });
  assert.equal((await dispatch(a, loom.id, 1)).status, 409);
  const bobbin = (await a.post("/api/bobbins", { name: "BB1", widthType: "single", meters: 20, color: "Blue" })).body;
  await a.post(`/api/bobbins/${bobbin.id}/move`, { to: "ready" });
  assert.equal((await a.post(`/api/bobbins/${bobbin.id}/move`, { to: "running", loomId: loom.id })).status, 200);
  const tooMuch = await dispatch(a, loom.id, 4); // 25.2 m, the bobbin has 20
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.body.error, /bobbin/i);
  const ok = await dispatch(a, loom.id, 2);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.bobbin.remainingMeters, 7.4);
  const last = await dispatch(a, loom.id, 1); // leaves 1.1 m, under one saree: the bobbin is used up
  assert.equal(last.status, 201);
  assert.equal(last.body.bobbin.status, "Completed");
  assert.equal((await dispatch(a, loom.id, 1)).status, 409, "the loom needs a new bobbin");
});

test("a bobbin on a warp-only loom, and width mismatches, are refused", async () => {
  const warpOnly = (await a.post("/api/looms", { name: "WO1", widthType: "single" })).body;
  const tripleLoom = (await a.post("/api/looms", { name: "TB1", widthType: "triple", needsBobbin: true })).body;
  const b = (await a.post("/api/bobbins", { name: "BX1", widthType: "single", meters: 50, color: "Blue" })).body;
  await a.post(`/api/bobbins/${b.id}/move`, { to: "ready" });
  assert.equal((await a.post(`/api/bobbins/${b.id}/move`, { to: "running", loomId: warpOnly.id })).status >= 400, true);
  assert.equal((await a.post(`/api/bobbins/${b.id}/move`, { to: "running", loomId: tripleLoom.id })).status >= 400, true);
});

test("editing a dispatch adjusts warp meters; it cannot exceed what is left", async () => {
  const { warp, loom } = await runningLoom(a, { name: "ED1", warpName: "ED-W", meters: 100 });
  const d = (await dispatch(a, loom.id, 5)).body.delivery;
  const up = await a.put(`/api/deliveries/${d.id}`, { sarees: 8 });
  assert.equal(up.status, 200);
  assert.equal((await dataOf(a)).warps.find(w => w.id === warp.id).remainingMeters, 49.6);
  assert.equal((await a.put(`/api/deliveries/${d.id}`, { sarees: 0 })).status, 400);
  assert.equal((await a.put(`/api/deliveries/${d.id}`, { sarees: 500 })).status, 400);
  assert.equal((await a.put(`/api/deliveries/${d.id}`, { lrNumber: "LR-9" })).status, 200);
});

test("removing a loom needs it stopped; its warp returns to Ready; deliveries keep the loom name", async () => {
  const { warp, loom } = await runningLoom(a, { name: "RM1", warpName: "RM-W" });
  await dispatch(a, loom.id, 1);
  assert.equal((await a.del(`/api/looms/${loom.id}`)).status, 409, "running");
  await a.post(`/api/looms/${loom.id}/stop`, {});
  assert.equal((await a.del(`/api/looms/${loom.id}`)).status, 200);
  const d = await dataOf(a);
  assert.equal(d.warps.find(w => w.id === warp.id).status, "Ready");
  assert.equal(d.deliveries.find(x => x.loomId === loom.id).loomName, "RM1");
});

test("loom edit: width cannot change while a warp is on it", async () => {
  const { loom } = await runningLoom(a, { name: "LE1", warpName: "LE-W" });
  assert.equal((await a.put(`/api/looms/${loom.id}`, { name: "LE1", widthType: "triple" })).status, 409);
  assert.equal((await a.put(`/api/looms/${loom.id}`, { name: "LE1-renamed", widthType: "single", needsBobbin: false })).status, 200);
});

test("correcting the sarees left on a warp (Edit sarees) updates its meters", async () => {
  const { warp } = await runningLoom(a, { name: "BE1", warpName: "BE-W", meters: 100 });
  assert.equal((await a.put(`/api/warps/${warp.id}/balance`, { leftSarees: -1 })).status, 400);
  assert.equal((await a.put(`/api/warps/${warp.id}/balance`, { leftSarees: 4 })).status, 200);
  const w = (await dataOf(a)).warps.find(x => x.id === warp.id);
  assert.ok(Math.abs(w.remainingMeters - (4 * 6.3 + 100 % 6.3)) < 0.02, `remaining ${w.remainingMeters}`);
  const ready = (await a.post("/api/warps", { name: "BE-idle", widthType: "single", meters: 50, bodyColor: "R", borderColor: "G" })).body;
  assert.equal((await a.put(`/api/warps/${ready.id}/balance`, { leftSarees: 2 })).status, 409, "only warps on a loom");
});

test("tile order is saved", async () => {
  const looms = (await dataOf(a)).looms.slice(0, 3).map(l => l.id).reverse();
  assert.equal((await a.post("/api/order", { kind: "looms", ids: looms })).status, 200);
  const after = (await dataOf(a)).looms;
  looms.forEach((id, i) => assert.equal(after.find(l => l.id === id).order, i));
  assert.equal((await a.post("/api/order", { kind: "nope", ids: [] })).status, 400);
});

test("every change is written to the activity log, newest first", async () => {
  const log = (await dataOf(a)).activity;
  assert.ok(log.length > 10);
  assert.ok(log.some(e => e.type === "dispatch" && /dispatched from/.test(e.text)));
  assert.ok(log.some(e => e.type === "warp"));
  assert.ok(log.some(e => e.type === "loom"));
  for (let i = 1; i < log.length; i++) assert.ok(log[i - 1].at >= log[i].at, "newest first");
});
