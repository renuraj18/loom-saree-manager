const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startApp, runningLoom, dataOf } = require("./helpers");

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
  assert.deepEqual(b.body.modules, { type: "own", stock: true, process: true, labour: true, weft: true });
});

test("Stock only (old type): labour and weft are off, Process is on; designs, expenses, stock and parties work", async () => {
  const f = await app.newFactory({ modules: { stock: true, wages: false } });
  assert.deepEqual(f.factory.modules, { type: "own", stock: true, process: true, labour: false, weft: false });
  assert.equal((await f.api.post("/api/wages/shifts", {})).status, 403);
  assert.equal((await f.api.post("/api/staff", { name: "X" })).status, 403);
  assert.equal((await f.api.post("/api/wefts", { name: "Z", kg: 1 })).status, 403);
  assert.equal((await f.api.post("/api/designs", { number: "D" })).status, 201, "no labour, so no wage is asked for");
  const loom = (await f.api.post("/api/looms", { name: "L", widthType: "single" })).body;
  assert.equal((await f.api.post("/api/expenses", { loomId: loom.id, kind: "spares", amount: 1, item: "a" })).status, 201);
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

// ---- Own factory vs Job work ----
const own = (o = {}) => ({ type: "own", process: false, weft: false, labour: false, ...o });
const mk = (modules, extra = {}) => app.newFactory({ modules, ...extra });

test("Own factory: Process, Weft and Labour are each a choice; Job work has Process only", async () => {
  const a = await mk(own({ process: true, weft: true, labour: true }));
  assert.deepEqual(a.factory.modules, { type: "own", stock: true, process: true, labour: true, weft: true });
  const b = await mk(own());
  assert.deepEqual(b.factory.modules, { type: "own", stock: true, process: false, labour: false, weft: false });
  const j = await mk({ type: "job", process: true, weft: true, labour: true });
  assert.deepEqual(j.factory.modules, { type: "job", stock: true, process: true, labour: false, weft: false }, "labour and weft are forced off for job work");
  assert.equal((await app.adminRaw.post("/api/admin/factories", { name: "NoStock", ...base, modules: { type: "own", stock: false } })).status, 400);
});

test("options turn the matching routes on and off", async () => {
  const none = await mk(own());
  assert.equal((await none.api.post("/api/staff", { name: "R" })).status, 403, "labour off");
  assert.equal((await none.api.post("/api/wefts", { name: "Z", kg: 1 })).status, 403, "weft off");
  assert.equal((await none.api.post("/api/designs", { number: "D" })).status, 201, "designs are always there");
  const labour = await mk(own({ labour: true }));
  assert.equal((await labour.api.post("/api/staff", { name: "R" })).status, 201);
  assert.equal((await labour.api.post("/api/wefts", { name: "Z", kg: 1 })).status, 403);
  const weft = await mk(own({ weft: true }));
  const party = (await weft.api.post("/api/clients", { name: "P" })).body;
  assert.equal((await weft.api.post("/api/wefts", { name: "Z", kg: 1, partyId: party.id })).status, 201);
  assert.equal((await weft.api.post("/api/staff", { name: "R" })).status, 403);
  const job = await mk({ type: "job", process: false });
  for (const [m, p, b] of [["post", "/api/staff", { name: "R" }], ["post", "/api/wefts", { name: "Z", kg: 1 }], ["post", "/api/wages/settle", {}]]) assert.equal((await job.api[m](p, b)).status, 403, p);
});

test("Process is the option that decides direct stock", async () => {
  const deliver = async process => {
    const f = await mk({ type: "job", process });
    const { loom } = await runningLoom(f.api);
    await f.api.post("/api/deliveries", { loomId: loom.id, sarees: 2 });
    const party = (await f.api.post("/api/clients", { name: "P" })).body;
    return f.api.post("/api/stock/move", { from: "stock", to: "dispatched", qty: 2, clientId: party.id });
  };
  assert.equal((await deliver(false)).status, 201, "no Process: dispatched sarees can be delivered to a party straight away");
  assert.equal((await deliver(true)).status, 400, "with Process they first go through godown, process and folding");
});

test("designs: the wage is asked for only with Labour; the design is still recorded on a dispatch", async () => {
  const f = await mk({ type: "job", process: false });
  assert.equal((await f.api.post("/api/designs", { number: "J1", name: "Job design" })).status, 201);
  const design = (await f.api.get("/api/data")).body.designs[0];
  assert.deepEqual([design.rate, design.weaverRate], [0, null]);
  const { loom } = await runningLoom(f.api);
  await f.api.post(`/api/looms/${loom.id}/setup`, { designId: design.id, staffId: "ignored" });
  const d = (await f.api.post("/api/deliveries", { loomId: loom.id, sarees: 2 })).body.delivery;
  assert.equal(d.designNo, "J1");
  for (const k of ["wage", "rate", "staffId", "staffName", "weaverWage"]) assert.equal(d[k], undefined, `${k} is not recorded without labour`);
  const own2 = await mk(own({ labour: true }));
  assert.equal((await own2.api.post("/api/designs", { number: "O1" })).status, 400, "an own factory with labour still needs the wage");
});

test("weft is used up only when the factory has the Weft option", async () => {
  const f = await mk(own({ weft: true }));
  const party = (await f.api.post("/api/clients", { name: "P" })).body;
  const weft = (await f.api.post("/api/wefts", { name: "Zari", kg: 2, partyId: party.id })).body;
  const design = (await f.api.post("/api/designs", { number: "W1", wefts: [{ weftId: weft.id, grams: 100 }] })).body;
  assert.equal(design.wefts.length, 1, "weft rows are stored with the Weft option");
  const { loom } = await runningLoom(f.api);
  await f.api.post(`/api/looms/${loom.id}/setup`, { designId: design.id });
  const d = (await f.api.post("/api/deliveries", { loomId: loom.id, sarees: 3 })).body.delivery;
  assert.equal(d.wefts[0].used, 300);
});

test("older factories (stock / wages / process) read as Own factory with the same options", () => {
  const { modulesOf } = require("../store");
  assert.deepEqual(modulesOf({}), { type: "own", stock: true, warp: true, process: false, labour: true, weft: true, designs: true, expenses: true });
  assert.deepEqual(modulesOf({ modules: { stock: true, wages: false } }), { type: "own", stock: true, warp: true, process: true, labour: false, weft: false, designs: true, expenses: true });
  assert.deepEqual(modulesOf({ modules: { stock: true, wages: true, process: true } }).process, true);
});

// ---- Loom types (defined in the factory, used when adding a loom) ----
test("loom types: validated per factory; ids are assigned and kept", async () => {
  const f = await mk(own());
  const put = body => app.adminRaw.put(`/api/admin/factories/${f.id}`, { name: f.factory.name, ...base, ...body });
  assert.equal((await put({ loomTypes: [{ name: "", widthType: "single" }] })).status, 400, "name needed");
  assert.equal((await put({ loomTypes: [{ name: "A", widthType: "single" }, { name: "a", widthType: "triple" }] })).status, 400, "unique names");
  assert.equal((await put({ loomTypes: [{ name: "A", widthType: "wide" }] })).status, 400, "width is single or triple");
  const ok = await put({ loomTypes: [{ name: "Rapier", widthType: "single" }, { name: "Jacquard", widthType: "triple", needsBobbin: true }] });
  assert.equal(ok.status, 200);
  const [rapier, jacquard] = ok.body.loomTypes;
  assert.ok(rapier.id && jacquard.id && rapier.id !== jacquard.id);
  assert.deepEqual([rapier.needsBobbin, jacquard.needsBobbin, jacquard.widthType], [false, true, "triple"]);
  const again = await put({ loomTypes: ok.body.loomTypes });
  assert.deepEqual(again.body.loomTypes.map(t => t.id), [rapier.id, jacquard.id], "ids are kept when the list is saved again");
  assert.equal((await put({ loomTypes: [] })).body.loomTypes.length, 0, "empty list = choose width by hand again");
});

test("adding a loom picks one of the factory's loom types, which sets its width and bobbin setting", async () => {
  const f = await mk(own());
  const types = (await app.adminRaw.put(`/api/admin/factories/${f.id}`, { name: f.factory.name, ...base, loomTypes: [{ name: "Rapier", widthType: "single" }, { name: "Jacquard", widthType: "triple", needsBobbin: true }] })).body.loomTypes;
  const [rapier, jacquard] = types;
  const a = f.api;
  assert.equal((await a.post("/api/looms", { name: "L0", widthType: "single" })).status, 400, "a type is required once the factory defines them");
  assert.equal((await a.post("/api/looms", { name: "L0", loomTypeId: "nope" })).status, 400, "unknown type");
  const l1 = await a.post("/api/looms", { name: "L1", loomTypeId: jacquard.id, widthType: "single", needsBobbin: false });
  assert.equal(l1.status, 201);
  assert.deepEqual([l1.body.widthType, l1.body.needsBobbin, l1.body.loomTypeId, l1.body.loomTypeName], ["triple", true, jacquard.id, "Jacquard"], "the type wins over what the request says");
  assert.match((await dataOf(a)).activity[0].text, /Loom L1 added · Jacquard · triple width · warp \+ bobbin/);
  // editing a loom can move it to another type while nothing is on it
  const edited = await a.put(`/api/looms/${l1.body.id}`, { name: "L1", loomTypeId: rapier.id });
  assert.deepEqual([edited.body.widthType, edited.body.needsBobbin, edited.body.loomTypeName], ["single", false, "Rapier"]);
  assert.match((await dataOf(a)).activity[0].text, /loom type Rapier/);
});

test("a loom type in use can be renamed, but not removed or changed", async () => {
  const f = await mk(own());
  const put = body => app.adminRaw.put(`/api/admin/factories/${f.id}`, { name: f.factory.name, ...base, ...body });
  const types = (await put({ loomTypes: [{ name: "Rapier", widthType: "single" }] })).body.loomTypes;
  await f.api.post("/api/looms", { name: "L1", loomTypeId: types[0].id });
  const removed = await put({ loomTypes: [] });
  assert.equal(removed.status, 409);
  assert.match(removed.body.error, /Rapier is used by L1/);
  const changed = await put({ loomTypes: [{ ...types[0], widthType: "triple" }] });
  assert.equal(changed.status, 409);
  assert.match(changed.body.error, /can't change/);
  assert.equal((await put({ loomTypes: [{ ...types[0], needsBobbin: true }] })).status, 409);
  const renamed = await put({ loomTypes: [{ ...types[0], name: "Rapier 2" }] });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.loomTypes[0].id, types[0].id);
  assert.equal((await put({ loomTypes: [...renamed.body.loomTypes, { name: "Extra", widthType: "triple" }] })).status, 200, "adding another type is fine");
});

test("a factory without loom types still adds looms by width", async () => {
  const f = await mk(own());
  const r = await f.api.post("/api/looms", { name: "Plain", widthType: "triple", needsBobbin: true });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.widthType, r.body.needsBobbin, r.body.loomTypeId], ["triple", true, undefined]);
});
