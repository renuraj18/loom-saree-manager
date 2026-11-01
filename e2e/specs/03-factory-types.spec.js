// Own factory (choose Process / Weft / Labour) versus Job work (Warp + Process only): what the factory dialog offers
// and which tabs, forms and wage figures each combination shows.
const { test, before, after } = require("node:test");
const { launch, scenario, assert } = require("../lib");

let ui, app, stop;
before(async () => { ({ ui, app, stop } = await launch()); await ui.login(); });
after(async () => { assert.deepEqual(await ui.jsErrors(), [], "page JavaScript errors"); await stop(); });

const openFactoryDialog = async () => {
  await ui.click("#userBtn"); await ui.click("#menuSettings"); await ui.waitVisible("#view-settings");
  await ui.click("#addFactoryBtn"); await ui.waitDialog("factoryDialog");
};
const createFactory = async (name, { type = "own", process = false, weft = false, labour = false } = {}) => {
  await openFactoryDialog();
  await ui.type("facName", name); await ui.type("facLocation", "Salem"); await ui.type("facOwner", "Owner");
  await ui.radio("facType", type);
  if (type === "own") { await ui.check("facWeft", weft); await ui.check("facLabour", labour); }
  await ui.check("facProcess", process);
  await ui.submit("factoryForm");
  await ui.toast(`${name} created`);
  await ui.switchFactory(name);
};
const tabs = async () => new Set(await ui.visibleTabs());

test("factory dialog: Own factory offers Warp (locked), Process, Weft and Labour", scenario(ui, async () => {
  await openFactoryDialog();
  assert.equal(await ui.js("return document.querySelector('input[name=facType]:checked').value"), "own");
  assert.equal(await ui.js("const w=document.getElementById('facWarp');return [w.checked,w.disabled]").then(String), "true,true", "Warp is ticked and cannot be changed");
  for (const id of ["facProcessBox", "facWeftBox", "facLabourBox"]) assert.equal(await ui.visible("#" + id), true, id);
  assert.equal(await ui.js("return document.getElementById('facProcess').checked"), false, "Process starts off");
  assert.equal(await ui.js("return [facWeft.checked, facLabour.checked].join()"), "true,true", "a new Own factory starts with Weft and Labour");
  assert.equal(await ui.visible("#facWageBox"), true, "wage options show with Labour");
}));

test("factory dialog: Job work has only Warp and Process; weft and labour are hidden and cleared", scenario(ui, async () => {
  await ui.radio("facType", "job");
  assert.equal(await ui.visible("#facWeftBox"), false);
  assert.equal(await ui.visible("#facLabourBox"), false);
  assert.equal(await ui.visible("#facProcessBox"), true);
  assert.equal(await ui.js("return [facWeft.checked, facLabour.checked].join()"), "false,false");
  assert.equal(await ui.visible("#facWageBox"), false, "no wage options without labour");
  assert.match(await ui.text("#facTypeHint"), /weft and labour are not needed/i);
  await ui.radio("facType", "own");
  assert.equal(await ui.visible("#facLabourBox"), true);
  await ui.check("facLabour", false);
  assert.equal(await ui.visible("#facWageBox"), false, "unticking Labour hides the wage options");
  await ui.check("facLabour", true);
  assert.equal(await ui.visible("#facWageBox"), true);
  await ui.closeDialogs();
}));

test("existing factories read as Own factory with their options", scenario(ui, async () => {
  await ui.click("#setFactoryTable [data-fac=edit]");
  await ui.waitDialog("factoryDialog");
  assert.equal(await ui.js("return document.querySelector('input[name=facType]:checked').value"), "own");
  assert.equal(await ui.js("return [facProcess.checked, facWeft.checked, facLabour.checked].join()"), "false,true,true");
  await ui.closeDialogs();
  assert.match(await ui.text("#setFactoryTable"), /Own factory · Weft · Labour/);
}));

// ---------------------------------------------------------------- Job work
test("job work: created with Process; the list says so and the tabs follow", scenario(ui, async () => {
  await createFactory("Job Co", { type: "job", process: true });
  const t = await tabs();
  for (const need of ["home", "looms", "warps", "bobbins", "looms", "process", "stock", "parties", "designs", "expenses", "log"]) assert.ok(t.has(need), `job work shows ${need}`);
  for (const gone of ["wefts", "wages"]) assert.ok(!t.has(gone), `job work hides ${gone}`);
  await ui.click("#userBtn"); await ui.click("#menuSettings");
  assert.match(await ui.text("#setFactoryTable"), /Job work · Process/);
}));

test("job work: a design needs no wage; the form has no wage or weft fields", scenario(ui, async () => {
  await ui.tab("designs");
  await ui.clickText("+ Add design");
  await ui.waitDialog("designDialog");
  assert.equal(await ui.visible("#designRateBox"), false);
  assert.equal(await ui.visible("#designWeaverBox"), false);
  assert.equal(await ui.visible("#designWeftBox"), false);
  await ui.type("designNo", "J-1");
  await ui.type("designName", "Peacock");
  await ui.submit("designForm");
  await ui.toast("Design J-1 added");
  const card = await ui.text("#designGrid");
  assert.match(card, /J-1/); assert.match(card, /Peacock/);
  assert.ok(!/labour per saree/i.test(card) && !/Weaver wage/i.test(card), "no wage lines on a job-work design");
}));

test("job work: loom setup asks for the design only; dispatch records no wage", scenario(ui, async () => {
  await ui.tab("warps");
  await ui.clickText("+ Add loom"); await ui.waitDialog("loomDialog");
  await ui.type("loomName", "Loom A"); await ui.submit("loomForm");
  await ui.clickText("+ Add warp"); await ui.waitDialog("warpDialog");
  await ui.type("warpName", "JW-1"); await ui.type("warpQty", "63"); await ui.type("warpBody", "Red");
  await ui.submit("warpForm");
  await ui.clickText("Mark ready", "#view-warps");
  await ui.waitText("#view-warps", "Start on loom");
  await ui.clickText("Start on loom", "#view-warps");
  await ui.askOk();
  await ui.waitDialog("setupDialog");
  assert.equal(await ui.visible("#setupStaffBox"), false, "no labourer for job work");
  assert.match(await ui.text("#setupDialogTitle"), /^Designs · Loom A/);
  await ui.click("#setupDesigns input[type=checkbox]");
  await ui.select("setupDesign", "J-1");
  await ui.submit("setupForm");
  await ui.toast("Loom A saved");
  const strip = await ui.text("#view-looms");
  assert.ok(!/Labourer/i.test(strip) && !/No labourer/i.test(strip), "the loom card has no labourer block");

  await ui.tab("looms");
  await ui.clickText("Dispatch", "#view-looms");
  await ui.waitDialog("deliveryDialog");
  await ui.type("deliverySarees", "4");
  const preview = await ui.text("#deliveryPreview");
  assert.match(preview, /Uses 25\.2 m of JW-1/);
  assert.ok(!/Wage/i.test(preview), "no wage in the preview: " + preview);
  await ui.submit("deliveryForm");
  await ui.toast("4 sarees dispatched");
  assert.equal(await ui.db("db.deliveries[0].wage === undefined && db.deliveries[0].designNo"), "J-1");
}));

test("job work with Process: the process steps run and the party gets the sarees", scenario(ui, async () => {
  await ui.tab("process");
  await ui.clickText("Receive at godown", "#view-process"); await ui.askOk();
  await ui.clickText("Send to process", "#view-process"); await ui.waitDialog("sortDialog"); await ui.submit("sortForm");
  await ui.clickText("Send to folding", "#view-process"); await ui.askOk();
  await ui.clickText("Add to stock", "#view-process"); await ui.waitDialog("sortDialog"); await ui.submit("sortForm");
  assert.equal(await ui.db("stockOf().stock"), 4);
  await ui.tab("parties");
  await ui.clickText("+ Add party"); await ui.waitDialog("clientDialog");
  await ui.type("clientName", "Sri Silks"); await ui.submit("clientForm");
  await ui.tab("stock");
  assert.ok(!(await ui.text("#stockBuckets")).includes("Weft in hand"), "no weft card in job work");
  await ui.waitText("#stockByParty", "Delivery to party");
  await ui.clickText("Delivery to party");
  await ui.waitDialog("actDialog");
  await ui.select("actParty", "Sri Silks");
  await ui.type("actQty", "3");
  await ui.submit("actForm");
  await ui.waitFor(() => ui.db("partyHolds(db.clients[0].id) === 3"), "party should hold 3");
  await ui.tab("parties");
  const card = await ui.text("#partyGrid");
  assert.match(card, /Total saree production\s+4 sarees/);
  assert.match(card, /Warp pending/);
  assert.ok(!/Weft/.test(card), "no weft on the party card: " + card);
  assert.equal(await ui.visible("#partyWeftHead"), false, "no 'party details by weft' section");
}));

// ---------------------------------------------------------------- Own factory combinations
test("own factory with Weft only: weft tab and design weft rows, no labour or wages", scenario(ui, async () => {
  await createFactory("Weft Only", { type: "own", weft: true, labour: false, process: false });
  const t = await tabs();
  assert.ok(t.has("wefts")); assert.ok(!t.has("wages")); assert.ok(!t.has("process"), "no Process tab without Process");
  await ui.tab("designs");
  await ui.clickText("+ Add design"); await ui.waitDialog("designDialog");
  assert.equal(await ui.visible("#designRateBox"), false, "no wage without labour");
  assert.equal(await ui.visible("#designWeftBox"), true, "weft rows with the Weft option");
  await ui.closeDialogs();
}));

test("own factory with Labour only: wages and labour, no weft", scenario(ui, async () => {
  await createFactory("Labour Only", { type: "own", weft: false, labour: true, process: false });
  const t = await tabs();
  assert.ok(t.has("wages")); assert.ok(!t.has("wefts"));
  await ui.tab("designs");
  await ui.clickText("+ Add design"); await ui.waitDialog("designDialog");
  assert.equal(await ui.visible("#designRateBox"), true, "the labour wage is asked for");
  assert.equal(await ui.visible("#designWeftBox"), false);
  assert.equal(await ui.js("return document.getElementById('designRate').required"), true);
  await ui.closeDialogs();
  await ui.tab("wages");
  await ui.clickText("Manage labour"); await ui.waitDialog("manageStaffDialog");
  await ui.closeDialogs();
}));

test("own factory with everything off: only the basics, and stock is direct (no Process tab)", scenario(ui, async () => {
  await createFactory("Basic Own", { type: "own" });
  const t = await tabs();
  for (const gone of ["wefts", "wages", "process"]) assert.ok(!t.has(gone), `${gone} is hidden`);
  for (const need of ["warps", "stock", "parties", "designs", "expenses"]) assert.ok(t.has(need), `${need} is there`);
  assert.equal(await ui.db("directStock()"), true);
}));

test("editing a factory changes its options and the tabs follow", scenario(ui, async () => {
  await ui.click("#userBtn"); await ui.click("#menuSettings"); await ui.waitVisible("#view-settings");
  await ui.js(`[...document.querySelectorAll('#setFactoryTable tr[data-id]')].find(r => r.textContent.includes('Basic Own')).querySelector('[data-fac=edit]').click()`);
  await ui.waitDialog("factoryDialog");
  await ui.check("facWeft", true);
  await ui.check("facLabour", true);
  await ui.check("facProcess", true);
  await ui.submit("factoryForm");
  await ui.toast("Basic Own updated");
  await ui.waitFor(async () => { const t = await tabs(); return ["wefts", "wages", "process"].every(x => t.has(x)); }, "Weft, Wages and Process tabs should appear");
  const t = await tabs();
  for (const need of ["wefts", "wages", "process"]) assert.ok(t.has(need), `${need} appears`);
  assert.match(await ui.text("#setFactoryTable"), /Basic Own[\s\S]*Own factory · Process · Weft · Labour/);
  // and back to job work: weft and labour are dropped
  await ui.js(`[...document.querySelectorAll('#setFactoryTable tr[data-id]')].find(r => r.textContent.includes('Basic Own')).querySelector('[data-fac=edit]').click()`);
  await ui.waitDialog("factoryDialog");
  await ui.radio("facType", "job");
  await ui.submit("factoryForm");
  await ui.toast("Basic Own updated");
  await ui.waitFor(async () => { const t = await tabs(); return !t.has("wefts") && !t.has("wages") && t.has("process"); }, "Weft and Wages tabs should go, Process stay");
}));
