// Loom types defined in the factory settings fill the Loom type list when adding a loom.
const { test, before, after } = require("node:test");
const { launch, scenario, assert } = require("../lib");

let ui, app, stop;
before(async () => { ({ ui, app, stop } = await launch()); await ui.login(); });
after(async () => { assert.deepEqual(await ui.jsErrors(), [], "page JavaScript errors"); await stop(); });

const settings = async () => { await ui.click("#userBtn"); await ui.click("#menuSettings"); await ui.waitVisible("#view-settings"); };
const typeRows = () => ui.js(`return [...document.querySelectorAll('#facLoomTypeRows .loomtyperow')].map(r => [r.querySelector('[data-f=name]').value, r.querySelector('[data-f=width]').value, r.querySelector('[data-f=bobbin]').value].join('|'))`);
const editFactory = async name => {
  await settings();
  await ui.js(`[...document.querySelectorAll('#setFactoryTable tr[data-id]')].find(r => r.textContent.includes(arguments[0])).querySelector('[data-fac=edit]').click()`.replace("arguments[0]", JSON.stringify(name)));
  await ui.waitDialog("factoryDialog");
};

test("factory dialog: a new factory starts with Single, Double and Triple width types you can edit", scenario(ui, async () => {
  await settings();
  await ui.click("#addFactoryBtn");
  await ui.waitDialog("factoryDialog");
  assert.deepEqual(await typeRows(), ["Single width|single|no", "Double width|double|no", "Triple width|triple|no"]);
  await ui.type("facName", "Type Mills"); await ui.type("facLocation", "Salem"); await ui.type("facOwner", "Owner");
  // add a third type: Jacquard, triple, runs on a bobbin
  await ui.click("#facLoomTypeAdd");
  await ui.js(`const r = [...document.querySelectorAll('#facLoomTypeRows .loomtyperow')].pop();
    const set = (f, v) => { const e = r.querySelector('[data-f=' + f + ']'); e.value = v; e.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('change', {bubbles:true})); };
    set('name', 'Jacquard'); set('width', 'triple'); set('bobbin', 'yes');`);
  await ui.submit("factoryForm");
  await ui.toast("Type Mills created");
  await ui.switchFactory("Type Mills");
  assert.deepEqual(await ui.db("currentFactory().loomTypes.map(t => [t.name, t.widthType, t.needsBobbin])"),
    [["Single width", "single", false], ["Double width", "double", false], ["Triple width", "triple", false], ["Jacquard", "triple", true]]);
}));

test("a blank loom type name is refused", scenario(ui, async () => {
  await editFactory("Type Mills");
  await ui.click("#facLoomTypeAdd");
  await ui.click("#factoryForm button[type=submit]");
  await ui.waitText("#factoryNotice", /Enter a name for loom type 5/);
  assert.equal(await ui.dialogOpen("factoryDialog"), true);
  await ui.closeDialogs();
}));

test("add loom: the list holds the factory's types; width and bobbin come from the choice", scenario(ui, async () => {
  await ui.tab("warps");
  await ui.clickText("+ Add loom");
  await ui.waitDialog("loomDialog");
  assert.deepEqual(await ui.options("loomTypeSel"), ["Single width", "Double width", "Triple width", "Jacquard"]);
  assert.equal(await ui.visible("#loomTypeBox"), true);
  assert.equal(await ui.visible("#loomWidthBox"), false, "no separate width choice");
  assert.equal(await ui.visible("#loomNeedsBox"), false, "no separate bobbin choice");
  assert.match(await ui.text("#loomTypeHint"), /Single width · warp only/);
  await ui.select("loomTypeSel", "Jacquard");
  assert.match(await ui.text("#loomTypeHint"), /Triple width · warp \+ bobbin/);
  await ui.type("loomName", "Loom J1");
  await ui.submit("loomForm");
  await ui.toast("Loom J1 added (Jacquard: triple width, warp + bobbin)");
  assert.deepEqual(await ui.db("(l => [l.widthType, l.needsBobbin, l.loomTypeName])(db.looms.find(x => x.name === 'Loom J1'))"), ["triple", true, "Jacquard"]);
  await ui.tab("loomlist");
  const row = await ui.text("#loomTable");
  assert.match(row, /Loom J1/); assert.match(row, /Jacquard/); assert.match(row, /Warp \+ bobbin/);
}));

test("the type shows when ordering a warp or bobbin for the loom", scenario(ui, async () => {
  await ui.tab("warps");
  await ui.clickText("+ Add warp");
  await ui.waitDialog("warpDialog");
  assert.ok((await ui.options("warpLoom")).includes("Loom J1 · Jacquard"), "the list shows the loom's type");
  await ui.select("warpLoom", "Loom J1");
  assert.equal(await ui.value("warpWidth"), "triple");
  assert.match(await ui.text("#warpLoomInfo"), /Loom type\s+Jacquard/);
  assert.match(await ui.text("#warpLoomInfo"), /Runs on\s+Warp \+ bobbin/);
  await ui.closeDialogs();
  await ui.tab("bobbins");
  await ui.click("#openBobbinForm");
  await ui.waitDialog("bobbinDialog");
  assert.ok((await ui.options("bobbinLoom")).includes("Loom J1 · Jacquard"), "a loom that uses a bobbin");
  await ui.closeDialogs();
}));

test("edit loom: the current type is chosen; another type changes width and bobbin", scenario(ui, async () => {
  await ui.tab("loomlist");
  await ui.clickText("Manage looms");
  await ui.waitDialog("manageLoomsDialog");
  await ui.js(`[...document.querySelectorAll('#manageLoomsList .mlrow')].find(r => r.textContent.includes('Loom J1')).querySelector('[data-lm=edit]').click()`);
  await ui.waitDialog("loomDialog");
  assert.equal(await ui.js("return document.getElementById('loomTypeSel').selectedOptions[0].text"), "Jacquard");
  await ui.select("loomTypeSel", "Single width");
  await ui.submit("loomForm");
  await ui.waitFor(() => ui.db("(l => l.widthType === 'single' && !l.needsBobbin && l.loomTypeName === 'Single width')(db.looms.find(x => x.name === 'Loom J1'))"), "Loom J1 should now be a Single width loom");
  await ui.closeDialogs();
}));

test("a loom type in use can be renamed but not removed", scenario(ui, async () => {
  await editFactory("Type Mills");
  // Single width is now used by Loom J1: removing it is refused
  await ui.js(`[...document.querySelectorAll('#facLoomTypeRows .loomtyperow')].find(r => r.querySelector('[data-f=name]').value === 'Single width').querySelector('[data-rm-type]').click()`);
  await ui.click("#factoryForm button[type=submit]");
  await ui.waitText("#factoryNotice", /Single width is used by Loom J1/);
  assert.equal(await ui.dialogOpen("factoryDialog"), true);
  await ui.closeDialogs();
  // renaming it is fine, and so is removing one nobody uses
  await editFactory("Type Mills");
  await ui.js(`const rows = [...document.querySelectorAll('#facLoomTypeRows .loomtyperow')];
    const n = rows.find(r => r.querySelector('[data-f=name]').value === 'Single width').querySelector('[data-f=name]'); n.value = 'Plain loom';
    for (const unused of ['Double width', 'Triple width']) rows.find(r => r.querySelector('[data-f=name]').value === unused).querySelector('[data-rm-type]').click();`);
  await ui.submit("factoryForm");
  await ui.toast("Type Mills updated");
  assert.deepEqual(await ui.db("currentFactory().loomTypes.map(t => t.name)"), ["Plain loom", "Jacquard"]);
  await ui.tab("loomlist");
  assert.match(await ui.text("#loomTable"), /Plain loom/, "the loom shows the renamed type");
}));

test("a factory with no loom types adds looms by width and bobbin, as before", scenario(ui, async () => {
  await app.newFactory({ modules: { type: "own" } }, "No Types");
  await ui.reload();
  await ui.switchFactory("No Types");
  await ui.tab("warps");
  await ui.clickText("+ Add loom");
  await ui.waitDialog("loomDialog");
  assert.equal(await ui.visible("#loomTypeBox"), false);
  assert.equal(await ui.visible("#loomWidthBox"), true);
  assert.equal(await ui.visible("#loomNeedsBox"), true);
  await ui.radio("loomWidth", "triple");
  await ui.radio("loomNeeds", "bobbin");
  await ui.type("loomName", "Plain 1");
  await ui.submit("loomForm");
  assert.deepEqual(await ui.db("(l => [l.widthType, l.needsBobbin, l.loomTypeId || null])(db.looms[0])"), ["triple", true, null]);
}));
