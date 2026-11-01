// Hook information (the number of hooks, e.g. on a Jacquard) is recorded when a loom is created, and can be edited.
const { test, before, after } = require("node:test");
const { launch, scenario, assert } = require("../lib");

let ui, app, stop, f;
before(async () => {
  ({ ui, app, stop } = await launch());
  f = await app.newFactory({ modules: { type: "own", process: false, weft: false, labour: false } }, "Hook Mills");
  await ui.login();
  await ui.switchFactory("Hook Mills");
});
after(async () => { assert.deepEqual(await ui.jsErrors(), [], "page JavaScript errors"); await stop(); });

const openAddLoom = async () => { await ui.tab("warps"); await ui.clickText("+ Add loom"); await ui.waitDialog("loomDialog"); };

test("add loom: hooks are an optional number kept with the loom", scenario(ui, async () => {
  await openAddLoom();
  assert.equal(await ui.visible("#loomHooks"), true);
  assert.match(await ui.text("#loomHooksBox"), /Hooks \(optional\)/);
  // whole numbers above zero only (the form enforces it)
  await ui.type("loomName", "Jac 1");
  await ui.type("loomHooks", "0");
  await ui.click("#loomForm button[type=submit]");
  assert.equal(await ui.dialogOpen("loomDialog"), true, "0 hooks is refused");
  await ui.type("loomHooks", "12.5");
  await ui.click("#loomForm button[type=submit]");
  assert.equal(await ui.dialogOpen("loomDialog"), true, "a fraction is refused");
  await ui.type("loomHooks", "960");
  await ui.radio("loomWidth", "triple");
  await ui.submit("loomForm");
  await ui.toast("Jac 1 added (triple width, warp only, 960 hooks)");
  assert.equal(await ui.db("db.looms.find(l => l.name === 'Jac 1').hooks"), 960);
}));

test("hooks can be left empty", scenario(ui, async () => {
  await openAddLoom();
  await ui.type("loomName", "Plain 1");
  await ui.submit("loomForm");
  await ui.toast("Plain 1 added");
  assert.equal(await ui.db("db.looms.find(l => l.name === 'Plain 1').hooks"), null);
}));

test("the hooks show on the loom list, the production card, manage looms and the log", scenario(ui, async () => {
  await ui.tab("loomlist");
  const table = await ui.text("#loomTable");
  assert.match(table, /Jac 1[\s\S]*960 hooks/);
  await ui.tab("looms");
  assert.match(await ui.js("return [...document.querySelectorAll('#view-looms .lcard')].find(c => c.textContent.includes('Jac 1')).innerText.replace(/\\s+/g,' ')"), /960 hooks/);
  await ui.tab("loomlist");
  await ui.clickText("Manage looms");
  await ui.waitDialog("manageLoomsDialog");
  assert.match(await ui.text("#manageLoomsList"), /Jac 1[\s\S]*960 hooks/);
  await ui.closeDialogs();
  await ui.tab("log");
  assert.match(await ui.text("#view-log"), /Loom Jac 1 added · triple width · warp only · 960 hooks/);
}));

test("ordering a warp for the loom shows its hooks with the other loom details", scenario(ui, async () => {
  await ui.tab("warps");
  await ui.clickText("+ Add warp");
  await ui.waitDialog("warpDialog");
  await ui.select("warpLoom", "Jac 1");
  assert.match(await ui.text("#warpLoomInfo"), /Hooks\s+960/);
  await ui.select("warpLoom", "Plain 1");
  assert.ok(!/Hooks/.test(await ui.text("#warpLoomInfo")), "a loom with no hooks shows no hooks row");
  await ui.closeDialogs();
}));

test("edit loom: the hooks are filled in; change them, then clear them", scenario(ui, async () => {
  const editLoom = async name => {
    await ui.tab("loomlist");
    await ui.clickText("Manage looms");
    await ui.waitDialog("manageLoomsDialog");
    await ui.js(`[...document.querySelectorAll('#manageLoomsList .mlrow')].find(r => r.textContent.includes(${JSON.stringify(name)})).querySelector('[data-lm=edit]').click()`);
    await ui.waitDialog("loomDialog");
  };
  await editLoom("Jac 1");
  assert.equal(await ui.value("loomHooks"), "960");
  await ui.type("loomHooks", "1344");
  await ui.submit("loomForm");
  await ui.waitFor(() => ui.db("db.looms.find(l => l.name === 'Jac 1').hooks === 1344"), "hooks should now be 1344");
  await ui.closeDialogs();
  await editLoom("Jac 1");
  await ui.type("loomHooks", "");
  await ui.submit("loomForm");
  await ui.waitFor(() => ui.db("db.looms.find(l => l.name === 'Jac 1').hooks === null"), "hooks should be cleared");
  await ui.closeDialogs();
  await ui.tab("log");
  const log = await ui.text("#view-log");
  assert.match(log, /Loom Jac 1 updated · 1344 hooks/);
  assert.match(log, /Loom Jac 1 updated · hooks cleared/);
}));

test("with loom types the hooks field is there too, next to the type list", scenario(ui, async () => {
  await app.adminRaw.put(`/api/admin/factories/${f.id}`, { name: "Hook Mills", location: "Test", ownerName: "Owner", loomTypes: [{ name: "Jacquard", widthType: "triple", needsBobbin: true }] });
  await ui.reload();
  await ui.switchFactory("Hook Mills");
  await openAddLoom();
  assert.equal(await ui.visible("#loomTypeBox"), true);
  assert.equal(await ui.visible("#loomHooksBox"), true);
  await ui.type("loomName", "Jac 2");
  await ui.type("loomHooks", "480");
  await ui.submit("loomForm");
  await ui.toast("Jac 2 added (Jacquard: triple width, warp + bobbin, 480 hooks)");
  assert.deepEqual(await ui.db("(l => [l.hooks, l.loomTypeName])(db.looms.find(x => x.name === 'Jac 2'))"), [480, "Jacquard"]);
}));
