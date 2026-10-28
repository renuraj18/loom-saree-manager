const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers");

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

test("first login on a fresh data dir is admin/admin and flags the default password", async () => {
  const r = await app.api().post("/api/auth/login", { username: "admin", password: "admin" });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  assert.equal(r.body.user.role, "admin");
  assert.equal(r.body.user.defaultPassword, true);
  assert.equal(r.body.factories.length, 1);
});

test("wrong password is rejected", async () => {
  const r = await app.api().post("/api/auth/login", { username: "admin", password: "nope" });
  assert.equal(r.status, 401);
});

test("data routes need a token and a factory", async () => {
  assert.equal((await app.api().get("/api/data")).status, 401);
  const noFactory = await app.api(app.token).get("/api/data"); // token but no X-Factory header
  assert.notEqual(noFactory.status, 200);
  assert.equal((await app.admin.get("/api/data")).status, 200);
});

test("a garbage token is rejected", async () => {
  assert.equal((await app.api("1.2.3.abc", app.factoryId).get("/api/data")).status, 401);
});

test("admin can create users; a user with a factory can work, but not use admin routes", async () => {
  const c = await app.adminRaw.post("/api/admin/users", { username: "ravi", name: "Ravi", password: "pass1", role: "user", factoryIds: [app.factoryId] });
  assert.equal(c.status, 201);
  const { token } = await app.login("ravi", "pass1");
  const u = app.api(token, app.factoryId);
  assert.equal((await u.get("/api/data")).status, 200);
  assert.equal((await app.api(token).get("/api/admin/info")).status, 403);
  assert.equal((await app.api(token).post("/api/admin/users", { username: "x1234", password: "abcd" })).status, 403);
});

test("duplicate or invalid usernames and short passwords are rejected", async () => {
  assert.equal((await app.adminRaw.post("/api/admin/users", { username: "ravi", password: "pass1" })).status, 409);
  assert.equal((await app.adminRaw.post("/api/admin/users", { username: "a", password: "pass1" })).status, 400);
  assert.equal((await app.adminRaw.post("/api/admin/users", { username: "newuser", password: "abc" })).status, 400);
});

test("a user cannot open a factory they were not given", async () => {
  const other = await app.newFactory();
  const { token } = await app.login("ravi", "pass1");
  assert.equal((await app.api(token, other.id).get("/api/data")).status, 403);
});

test("role user cannot discard warps or remove looms; admin can", async () => {
  const { token } = await app.login("ravi", "pass1");
  const u = app.api(token, app.factoryId);
  const warp = (await u.post("/api/warps", { name: "WX", widthType: "single", meters: 100, bodyColor: "Red", borderColor: "Blue" })).body;
  const loom = (await u.post("/api/looms", { name: "LX", widthType: "single" })).body;
  assert.equal((await u.post(`/api/warps/${warp.id}/discard`, {})).status, 403);
  assert.equal((await u.del(`/api/looms/${loom.id}`)).status, 403);
  assert.equal((await app.admin.post(`/api/warps/${warp.id}/discard`, { reason: "test" })).status, 200);
  assert.equal((await app.admin.del(`/api/looms/${loom.id}`)).status, 200);
});

test("users cannot remove staff or designs (admin only)", async () => {
  const { token } = await app.login("ravi", "pass1");
  const u = app.api(token, app.factoryId);
  const staff = (await u.post("/api/staff", { name: "Wv" })).body;
  const design = (await u.post("/api/designs", { number: "AD-1", rate: 100 })).body;
  assert.equal((await u.del(`/api/staff/${staff.id}`)).status, 403);
  assert.equal((await u.del(`/api/designs/${design.id}`)).status, 403);
  assert.equal((await app.admin.del(`/api/staff/${staff.id}`)).status, 200);
  assert.equal((await app.admin.del(`/api/designs/${design.id}`)).status, 200);
});

test("changing your own password signs out old tokens and clears the default flag", async () => {
  await app.adminRaw.post("/api/admin/users", { username: "pwuser", password: "oldpw", role: "user", factoryIds: [app.factoryId] });
  const { token } = await app.login("pwuser", "oldpw");
  const me = app.api(token);
  assert.equal((await me.post("/api/auth/password", { currentPassword: "WRONG", newPassword: "newpw1" })).status, 400);
  assert.equal((await me.post("/api/auth/password", { currentPassword: "oldpw", newPassword: "ab" })).status, 400);
  const ok = await me.post("/api/auth/password", { currentPassword: "oldpw", newPassword: "newpw1" });
  assert.equal(ok.status, 200);
  assert.equal((await me.get("/api/auth/me")).status, 401, "old token no longer valid");
  assert.equal((await app.api(ok.body.token).get("/api/auth/me")).status, 200);
  assert.equal((await app.api().post("/api/auth/login", { username: "pwuser", password: "oldpw" })).status, 401);
  assert.ok((await app.login("pwuser", "newpw1")).token);
});

test("an admin editing another user signs that user out", async () => {
  const { token } = await app.login("ravi", "pass1");
  const users = (await app.adminRaw.get("/api/admin/info")).body.users;
  const ravi = users.find(x => x.username === "ravi");
  const r = await app.adminRaw.put(`/api/admin/users/${ravi.id}`, { username: "ravi", name: "Ravi K", role: "user", factoryIds: [app.factoryId] });
  assert.equal(r.status, 200);
  assert.equal((await app.api(token).get("/api/auth/me")).status, 401);
});

test("you cannot delete or demote yourself, and the last admin must remain", async () => {
  const info = (await app.adminRaw.get("/api/admin/info")).body;
  const me = info.users.find(u => u.username === "admin");
  assert.equal((await app.adminRaw.del(`/api/admin/users/${me.id}`)).status, 400);
  assert.equal((await app.adminRaw.put(`/api/admin/users/${me.id}`, { username: "admin", role: "user" })).status, 400);
});
