// Party (job-work giver) app: party accounts, factories a party registers, owner logins and permissions,
// job orders, warp/bobbin requests and approvals, shipments, announcements and live updates.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { startApp, dataOf } = require("./helpers");

let app, partyApi, partyToken, factoryId, ownerApi, ownerToken, partyId;
before(async () => {
  app = await startApp();
  const p = await app.adminRaw.post("/api/admin/parties", { name: "Sri Lakshmi Silks", phone: "99999", username: "lakshmi", password: "pass1" });
  assert.equal(p.status, 201);
  partyId = p.body.id;
  const login = await app.login("lakshmi", "pass1");
  partyToken = login.token;
  partyApi = app.api(partyToken);
  assert.equal(login.user.role, "party");
  assert.equal(login.party.name, "Sri Lakshmi Silks");
});
after(() => app.stop());

test("a party account cannot use the factory routes or admin routes", async () => {
  const r = await app.api(partyToken, app.factoryId).get("/api/data");
  assert.equal(r.status, 403);
  assert.equal((await partyApi.get("/api/admin/info")).status, 403);
  assert.equal((await app.admin.get("/api/party/overview")).status, 403, "factory users cannot use the party API");
});

test("a party registers a factory and creates its owner login", async () => {
  const bad = await partyApi.post("/api/party/factories", { name: "Ram Weaving Works", ownerName: "Ramesh", username: "ramesh" });
  assert.equal(bad.status, 400, "a new owner login needs a password");
  const r = await partyApi.post("/api/party/factories", { name: "Ram Weaving Works", location: "Elampillai", ownerName: "Ramesh", ownerPhone: "98765", username: "ramesh", password: "own1" });
  assert.equal(r.status, 201);
  factoryId = r.body.factory.id;
  assert.deepEqual(r.body.factory.partyIds, [partyId]);
  const owner = await app.login("ramesh", "own1");
  ownerToken = owner.token;
  assert.equal(owner.user.role, "user");
  assert.deepEqual(owner.factories.map(f => f.id), [factoryId]);
  ownerApi = app.api(ownerToken, factoryId);
  const me = await partyApi.get("/api/auth/me");
  assert.deepEqual(me.body.factories.map(f => f.id), [factoryId]);
  const ov = await partyApi.get("/api/party/overview");
  assert.equal(ov.body.factories[0].owners[0].username, "ramesh");
});

let loomId, designId, jobId;
test("looms and designs are set up by the party; the owner cannot add or edit them", async () => {
  const l = await partyApi.post(`/api/party/factories/${factoryId}/looms`, { name: "Loom 3", widthType: "triple", needsBobbin: true });
  assert.equal(l.status, 201);
  loomId = l.body.id;
  assert.equal(l.body.partyId, partyId);
  const d = await partyApi.post(`/api/party/factories/${factoryId}/designs`, { number: "D-12", name: "Kanchi butta", jobRate: 450 });
  assert.equal(d.status, 201);
  designId = d.body.id;
  assert.equal((await ownerApi.post("/api/looms", { name: "Loom 9", widthType: "single" })).status, 403);
  assert.equal((await ownerApi.put(`/api/looms/${loomId}`, { name: "X", widthType: "triple", needsBobbin: true })).status, 403);
  assert.equal((await ownerApi.post("/api/designs", { number: "D-99", rate: 10 })).status, 403);
  // The owner may set the weaver's wage on the party's design, but its number and name stay the party's.
  const w = await ownerApi.put(`/api/designs/${designId}`, { number: "CHANGED", name: "Other", rate: 30 });
  assert.equal(w.status, 200);
  assert.equal(w.body.number, "D-12");
  assert.equal(w.body.rate, 30);
  // Another party's factory is not reachable.
  assert.equal((await partyApi.post(`/api/party/factories/${app.factoryId}/looms`, { name: "L", widthType: "single" })).status, 404);
});

test("job orders track woven, sent and received sarees", async () => {
  const j = await partyApi.post(`/api/party/factories/${factoryId}/job-orders`, { designId, target: 30, loomIds: [loomId] });
  assert.equal(j.status, 201);
  jobId = j.body.id;
  assert.equal(j.body.code, "JWO-0001");
  assert.equal(j.body.toWeave, 30);
  // Owner adds a warp and bobbin and runs the loom.
  const warp = (await ownerApi.post("/api/warps", { name: "W-104", widthType: "triple", meters: 63, bodyColor: "Maroon", borderColor: "Gold" })).body;
  const bob = (await ownerApi.post("/api/bobbins", { name: "B-33", widthType: "triple", meters: 63, color: "Gold" })).body;
  for (const [kind, x] of [["warps", warp], ["bobbins", bob]]) {
    await ownerApi.post(`/api/${kind}/${x.id}/move`, { to: "ready" });
    assert.equal((await ownerApi.post(`/api/${kind}/${x.id}/move`, { to: "running", loomId })).status, 200);
  }
  const d = await ownerApi.post("/api/deliveries", { loomId, sarees: 12 });
  assert.equal(d.status, 201);
  assert.equal(d.body.delivery.jobOrderId, jobId);
  assert.equal(d.body.delivery.partyId, partyId);
  const tooMany = await ownerApi.post("/api/shipments", { jobOrderId: jobId, qty: 13 });
  assert.equal(tooMany.status, 400);
  const s = await ownerApi.post("/api/shipments", { jobOrderId: jobId, qty: 9, lrNumber: "55821" });
  assert.equal(s.status, 201);
  assert.deepEqual([s.body.jobOrder.woven, s.body.jobOrder.sent, s.body.jobOrder.atFactory, s.body.jobOrder.onWay], [12, 9, 3, 9]);
  const rcv = await partyApi.post(`/api/party/factories/${factoryId}/shipments/${s.body.shipment.id}/receive`, {});
  assert.equal(rcv.status, 200);
  const ov = (await partyApi.get("/api/party/overview")).body.factories[0];
  const jo = ov.jobOrders[0];
  assert.deepEqual([jo.received, jo.onWay, jo.toWeave, jo.pending], [9, 0, 18, 21]);
  const loom = ov.looms[0];
  assert.equal(loom.today, 12);
  assert.equal(loom.warp.name, "W-104");
  assert.equal(loom.warp.sareesLeft, 18);
  assert.equal(loom.bobbin.sareesLeft, 18);
  assert.ok(ov.feed.some(e => /dispatched from Loom 3/.test(e.text)), "the party sees dispatches from its looms in its feed");
  assert.equal((await dataOf(ownerApi)).jobOrders[0].woven, 12);
});

test("the owner requests warp or bobbin; the party approves and it lands on the board as ordered", async () => {
  const bad = await ownerApi.post("/api/requests", { kind: "warp", loomId, sarees: 10 });
  assert.equal(bad.status, 400, "triple width needs multiples of 3");
  const r = await ownerApi.post("/api/requests", { kind: "warp", loomId, sarees: 54, needBy: "2026-11-03", note: "W-104 ends soon" });
  assert.equal(r.status, 201);
  assert.equal(r.body.meters, 113.4);
  assert.equal((await ownerApi.post("/api/requests", { kind: "warp", loomId, sarees: 54 })).status, 409, "one waiting request per loom and kind");
  const w = await ownerApi.post("/api/requests", { kind: "bobbin", loomId, sarees: 30 });
  assert.equal(w.status, 201);
  const ok = await partyApi.post(`/api/party/factories/${factoryId}/requests/${r.body.id}/decide`, { approve: true, name: "W-122" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.item.status, "Ordered");
  assert.equal(ok.body.item.partyId, partyId);
  assert.equal(ok.body.item.bodyColor, "Maroon", "colours default to the loom's current warp");
  const no = await partyApi.post(`/api/party/factories/${factoryId}/requests/${w.body.id}/decide`, { approve: false, reason: "Use B-36" });
  assert.equal(no.body.status, "rejected");
  const db = await dataOf(ownerApi);
  assert.ok(db.warps.some(x => x.name === "W-122" && x.forLoomId === loomId));
  assert.equal((await partyApi.post(`/api/party/factories/${factoryId}/requests/${r.body.id}/decide`, { approve: true })).status, 409);
});

test("the party decides what the owner may do on its looms", async () => {
  const p = await partyApi.put(`/api/party/factories/${factoryId}/perms`, { perms: { dispatch: false, stop: false } });
  assert.equal(p.status, 200);
  assert.equal((await ownerApi.post("/api/deliveries", { loomId, sarees: 3 })).status, 403);
  assert.equal((await ownerApi.post(`/api/looms/${loomId}/stop`, { reason: "x" })).status, 403);
  // An admin is never blocked.
  assert.equal((await app.api(app.token, factoryId).post("/api/deliveries", { loomId, sarees: 3 })).status, 201);
  const db = await dataOf(ownerApi);
  assert.equal(db.parties[0].perms.dispatch, false);
  assert.equal(db.partyManaged, true);
  await partyApi.put(`/api/party/factories/${factoryId}/perms`, { perms: { dispatch: true, stop: true } });
  assert.equal((await ownerApi.post("/api/deliveries", { loomId, sarees: 3 })).status, 201);
});

test("announcements reach the owner, who confirms them", async () => {
  const bad = await partyApi.post("/api/party/announcements", { factoryIds: [app.factoryId], title: "Hi" });
  assert.equal(bad.status, 400, "only the party's own factories");
  const a = await partyApi.post("/api/party/announcements", { factoryIds: [factoryId], kind: "warp", title: "Warp W-122 ready for Loom 3", body: "Leaves tomorrow 10 AM." });
  assert.equal(a.status, 201);
  const db = await dataOf(ownerApi);
  const ann = db.announcements[0];
  assert.equal(ann.title, "Warp W-122 ready for Loom 3");
  const ack = await ownerApi.post(`/api/announcements/${ann.id}/ack`, {});
  assert.equal(ack.body.acks[0].name, "Ramesh");
  const ov = (await partyApi.get("/api/party/overview")).body.factories[0];
  assert.equal(ov.announcements[0].acks.length, 1);
});

test("admin links a party to an existing factory, which becomes party-managed", async () => {
  const r = await app.adminRaw.put(`/api/admin/parties/${partyId}`, { factoryIds: [factoryId, app.factoryId] });
  assert.equal(r.status, 200);
  assert.equal((await app.admin.get("/api/data")).body.partyManaged, true);
  const me = await partyApi.get("/api/auth/me");
  assert.equal(me.body.factories.length, 2);
  await app.adminRaw.put(`/api/admin/parties/${partyId}`, { factoryIds: [factoryId] });
  assert.equal((await app.admin.get("/api/data")).body.partyManaged, false);
  // Editing the party login in Settings keeps it a party login.
  const info = (await app.adminRaw.get("/api/admin/info")).body;
  const u = info.users.find(x => x.username === "lakshmi");
  const e = await app.adminRaw.put(`/api/admin/users/${u.id}`, { username: "lakshmi", name: "SL", role: "user", factoryIds: [factoryId] });
  assert.equal(e.body.role, "party");
  assert.deepEqual(e.body.factoryIds, []);
});

test("live updates: a write to a factory reaches the party's event stream", async () => {
  assert.equal((await app.api().get("/api/events?token=bad")).status, 401);
  partyToken = (await app.login("lakshmi", "pass1")).token; // the admin edit above signed the party out
  const got = await new Promise((resolve, reject) => {
    const req = http.get(`${app.url}/api/events?token=${encodeURIComponent(partyToken)}`, res => {
      let buf = "";
      res.on("data", chunk => {
        buf += chunk;
        const m = buf.match(/data: (\{.*\})\n\n/);
        if (m) { req.destroy(); resolve(JSON.parse(m[1])); }
      });
    });
    req.on("error", e => { if (e.code !== "ECONNRESET") reject(e); });
    setTimeout(() => ownerApi.post(`/api/looms/${loomId}/stop`, { reason: "power cut" }), 200);
    setTimeout(() => reject(new Error("no event")), 5000);
  });
  assert.equal(got.factoryId, factoryId);
});
