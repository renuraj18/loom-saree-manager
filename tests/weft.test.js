const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startApp, runningLoom, dispatch } = require("./helpers");

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

async function weftFactory(modules = { stock: true, wages: true }) {
  const f = await app.newFactory({ modules });
  const a = f.api;
  const { loom } = await runningLoom(a, { meters: 1000 });
  return { ...f, a, loom };
}

test("a design stores weft grams per saree (optional, above 0) and logs changes", async () => {
  const { a } = await weftFactory();
  assert.equal((await a.post("/api/designs", { number: "A", rate: 10, weftGrams: -5 })).status, 400);
  assert.equal((await a.post("/api/designs", { number: "A", rate: 10, weftGrams: "x" })).status, 400);
  const d = (await a.post("/api/designs", { number: "A", rate: 10, weftGrams: 450 })).body;
  assert.equal(d.weftGrams, 450);
  assert.equal((await a.post("/api/designs", { number: "B", rate: 10 })).body.weftGrams, null);
  const up = await a.put(`/api/designs/${d.id}`, { number: "A", rate: 10, weftGrams: 400.5 });
  assert.equal(up.body.weftGrams, 400.5);
  const log = (await a.get("/api/data")).body.activity[0].text;
  assert.match(log, /weft g per saree 450 → 400.5/);
});

test("a dispatch snapshots the design's weft grams; later design edits do not change it", async () => {
  const { a, loom } = await weftFactory();
  const d = (await a.post("/api/designs", { number: "A", rate: 10, weftGrams: 450 })).body;
  await a.post(`/api/looms/${loom.id}/setup`, { designId: d.id });
  const r = await dispatch(a, loom.id, 4);
  assert.equal(r.status, 201);
  assert.equal(r.body.delivery.weftGrams, 450);
  await a.put(`/api/designs/${d.id}`, { number: "A", rate: 10, weftGrams: 500 });
  const old = (await a.get("/api/data")).body.deliveries[0];
  assert.equal(old.weftGrams, 450, "snapshot kept");
  const d2 = (await a.post("/api/designs", { number: "N", rate: 10 })).body;
  await a.post(`/api/looms/${loom.id}/setup`, { designId: d2.id });
  assert.equal((await dispatch(a, loom.id, 1)).body.delivery.weftGrams, undefined, "no grams set, nothing recorded");
});

test("weft entries: received / taken out, validation, edit, delete and log", async () => {
  const { a } = await weftFactory();
  const d = (await a.post("/api/designs", { number: "A", rate: 10, weftGrams: 450 })).body;
  assert.equal((await a.post("/api/weft", { grams: 0 })).status, 400);
  assert.equal((await a.post("/api/weft", { grams: "x" })).status, 400);
  assert.equal((await a.post("/api/weft", { grams: 100, kind: "bogus" })).status, 400);
  assert.equal((await a.post("/api/weft", { grams: 100, date: "2026-02-31" })).status, 400);
  assert.equal((await a.post("/api/weft", { grams: 100, designId: "nope" })).status, 400);
  const r = await a.post("/api/weft", { grams: 5000, designId: d.id, colour: "Gold", vendor: "Ravi Yarns", billNo: "B1" });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.kind, r.body.grams, r.body.designNo, r.body.colour], ["in", 5000, "A", "Gold"]);
  const out = await a.post("/api/weft", { kind: "out", grams: 250 });
  assert.equal(out.body.kind, "out");
  const up = await a.put(`/api/weft/${r.body.id}`, { grams: 6000, designId: d.id });
  assert.equal(up.body.grams, 6000);
  const data = (await a.get("/api/data")).body;
  assert.equal(data.weftStock.length, 2);
  assert.equal(data.activity[0].type, "weft");
  assert.equal((await a.del(`/api/weft/${out.body.id}`)).status, 200);
  assert.equal((await a.del(`/api/weft/${out.body.id}`)).status, 404);
  assert.equal((await a.get("/api/data")).body.weftStock.length, 1);
});

test("weft follows the Wages module", async () => {
  const f = await app.newFactory({ modules: { stock: true, wages: false } });
  assert.equal((await f.api.post("/api/weft", { grams: 100 })).status, 403);
});

test("a design's weft is added part by part: main weft, meena 1, meena 2, jari", async () => {
  const { a, loom } = await weftFactory();
  const post = weft => a.post("/api/designs", { number: "P" + Math.random(), rate: 10, weft });
  assert.equal((await post([{ kind: "silk", grams: 5 }])).status, 400, "unknown part");
  assert.equal((await post([{ kind: "jari", grams: 0 }])).status, 400, "grams above 0");
  assert.equal((await post([{ kind: "jari", grams: 5 }, { kind: "jari", grams: 6 }])).status, 400, "each part once");
  const d = (await post([{ kind: "main", grams: 300 }, { kind: "meena1", grams: 40.5 }, { kind: "jari", grams: 20 }])).body;
  assert.deepEqual(d.weft.map(p => p.kind), ["main", "meena1", "jari"]);
  assert.equal(d.weftGrams, 360.5, "total per saree");
  await a.post(`/api/looms/${loom.id}/setup`, { designId: d.id });
  const del = (await dispatch(a, loom.id, 2)).body.delivery;
  assert.equal(del.weftGrams, 360.5);
  assert.deepEqual(del.weft.map(p => [p.kind, p.grams]), [["main", 300], ["meena1", 40.5], ["jari", 20]]);
  const up = (await a.put(`/api/designs/${d.id}`, { number: d.number, rate: 10, weft: [{ kind: "meena2", grams: 15 }] })).body;
  assert.deepEqual([up.weft.length, up.weftGrams], [1, 15]);
  assert.match((await a.get("/api/data")).body.activity[0].text, /weft Main weft 300 g, Meena 1 40.5 g, Jari 20 g → Meena 2 15 g/);
  assert.equal((await a.put(`/api/designs/${d.id}`, { number: d.number, rate: 10, weft: [] })).body.weftGrams, null);
});

test("weft entries can name the part they are for", async () => {
  const { a } = await weftFactory();
  assert.equal((await a.post("/api/weft", { grams: 100, part: "silk" })).status, 400);
  const r = (await a.post("/api/weft", { grams: 100, part: "jari" })).body;
  assert.deepEqual([r.part, r.partName], ["jari", "Jari"]);
  assert.equal((await a.post("/api/weft", { grams: 100 })).body.part, "");
});
