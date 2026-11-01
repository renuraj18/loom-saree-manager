// Warps and bobbins can be ordered for a loom: the choice is limited to looms of the same width (bobbins: looms that
// use a bobbin), shows on the card, and is the default when the item is started on a loom.
const { test, before, after } = require("node:test");
const { launch, scenario, assert } = require("../lib");

let ui, app, stop, a;
before(async () => {
  ({ ui, app, stop } = await launch());
  const f = await app.newFactory({ modules: { type: "own", process: false, weft: false, labour: false } }, "Loom Plan");
  a = f.api;
  await a.post("/api/looms", { name: "S1", widthType: "single" });
  await a.post("/api/looms", { name: "T1", widthType: "triple" });
  await a.post("/api/looms", { name: "S2", widthType: "single", needsBobbin: true });
  await ui.login();
  await ui.switchFactory("Loom Plan");
});
after(async () => { assert.deepEqual(await ui.jsErrors(), [], "page JavaScript errors"); await stop(); });

const addWarp = async (name, width, loom) => {
  await ui.tab("warps");
  await ui.clickText("+ Add warp");
  await ui.waitDialog("warpDialog");
  await ui.type("warpName", name);
  if (loom) await ui.select("warpLoom", loom); else await ui.select("warpWidth", width);
  await ui.type("warpQty", "63");
  await ui.type("warpBody", "Red");
  await ui.submit("warpForm");
  await ui.waitText("#view-warps", name);
};

test("warp form: the loom is the first choice; picking one pulls in its details and sets the width", scenario(ui, async () => {
  await ui.tab("warps");
  await ui.clickText("+ Add warp");
  await ui.waitDialog("warpDialog");
  assert.equal(await ui.js("return document.querySelector('#warpForm .field').id"), "warpLoomField", "the loom is the top field");
  assert.deepEqual((await ui.options("warpLoom")).sort(), ["— No loom yet (choose the width below) —", "S1 · Single width", "S2 · Single width", "T1 · Triple width"].sort());
  assert.equal(await ui.visible("#warpLoomInfo"), false, "no details until a loom is chosen");
  assert.equal(await ui.js("return document.getElementById('warpWidth').disabled"), false, "width is free without a loom");
  // a triple loom: width follows and is locked, details show
  await ui.select("warpLoom", "T1");
  assert.equal(await ui.value("warpWidth"), "triple");
  assert.equal(await ui.js("return document.getElementById('warpWidth').disabled"), true, "width follows the loom");
  let info = await ui.text("#warpLoomInfo");
  assert.match(info, /Loom type\s+—/); assert.match(info, /Width\s+Triple width · 3 sarees per 6\.3 m/);
  assert.match(info, /Runs on\s+Warp only/); assert.match(info, /Now\s+Stopped · No warp/);
  // a loom that uses a bobbin
  await ui.select("warpLoom", "S2");
  assert.equal(await ui.value("warpWidth"), "single");
  info = await ui.text("#warpLoomInfo");
  assert.match(info, /Runs on\s+Warp \+ bobbin/);
  // none again: width is free
  await ui.select("warpLoom", "No loom yet");
  assert.equal(await ui.visible("#warpLoomInfo"), false);
  assert.equal(await ui.js("return document.getElementById('warpWidth').disabled"), false);
  await ui.closeDialogs();
}));

test("bobbin form: only looms that use a bobbin; picking one fills in the width and details", scenario(ui, async () => {
  await ui.tab("bobbins");
  await ui.click("#openBobbinForm");
  await ui.waitDialog("bobbinDialog");
  assert.equal(await ui.js("return document.querySelector('#bobbinForm .field').id"), "bobbinLoomField");
  assert.deepEqual(await ui.options("bobbinLoom"), ["— No loom yet (choose the width below) —", "S2 · Single width"]);
  await ui.select("bobbinLoom", "S2");
  assert.equal(await ui.value("bobbinWidth"), "single");
  assert.equal(await ui.js("return document.getElementById('bobbinWidth').disabled"), true);
  assert.match(await ui.text("#bobbinLoomInfo"), /Runs on\s+Warp \+ bobbin/);
  await ui.closeDialogs();
}));

test("a warp ordered for a loom shows it on the card and starts on it by default", scenario(ui, async () => {
  await addWarp("PW-1", "Single", "S1");
  assert.match(await ui.text("#view-warps"), /For loom: S1/);
  assert.equal(await ui.db("db.warps[0].plannedLoomName"), "S1");
  assert.equal(await ui.db("db.looms.find(l => l.name === 'S1').warpId || null"), null, "ordering for a loom does not put it on the loom");
  await ui.clickText("Mark ready", "#view-warps");
  await ui.waitText("#view-warps", "Start on loom");
  await ui.clickText("Start on loom", "#view-warps");
  await ui.waitDialog("askDialog");
  assert.match(await ui.text("#askText"), /Ordered for S1\./);
  const opts = await ui.options("askPick");
  assert.equal(opts[0], "S1 · ordered for this", "the planned loom is first");
  assert.equal(opts.length, 2, "S1 and S2 are the free single looms");
  await ui.askOk();
  await ui.waitFor(() => ui.db("db.looms.find(l => l.name === 'S1').warpId === db.warps.find(w => w.name === 'PW-1').id"), "PW-1 should be on S1");
  await ui.waitDialog("setupDialog");   // a design is asked for after a warp starts
  await ui.closeDialogs();
}));

test("when the ordered-for loom is busy the start dialog says so and offers the others", scenario(ui, async () => {
  await addWarp("PW-2", "Single", "S1");   // S1 now runs PW-1
  assert.match(await ui.text("#view-warps"), /For loom: S1/);
  await ui.js(`[...document.querySelectorAll('#view-warps [data-item]')].find(c => c.textContent.includes('PW-2')).querySelector('[data-act=ready]').click()`);
  await ui.waitFor(() => ui.db("db.warps.find(w => w.name === 'PW-2').status === 'Ready'"), "PW-2 should be ready");
  await ui.js(`[...document.querySelectorAll('#view-warps [data-item]')].find(c => c.textContent.includes('PW-2')).querySelector('[data-act=running]').click()`);
  await ui.waitDialog("askDialog");
  assert.match(await ui.text("#askText"), /Ordered for S1, which is not free right now/);
  assert.deepEqual(await ui.options("askPick"), ["S2"]);
  await ui.askCancel();
}));

test("a bobbin ordered for a loom shows it too, and a mismatched loom is refused by the server", scenario(ui, async () => {
  await ui.tab("bobbins");
  await ui.click("#openBobbinForm");
  await ui.waitDialog("bobbinDialog");
  await ui.select("bobbinWidth", "Single");
  await ui.type("bobbinName", "PB-1");
  await ui.type("bobbinQty", "63");
  await ui.type("bobbinColor", "Gold");
  await ui.select("bobbinLoom", "S2");
  await ui.submit("bobbinForm");
  await ui.waitText("#view-bobbins", "PB-1");
  assert.match(await ui.text("#view-bobbins"), /For loom: S2/);
  // the form never offers a wrong loom, but the server checks too
  const t = (await a.get("/api/data")).body.looms.find(l => l.name === "T1");
  const r = await a.post("/api/warps", { name: "PW-X", widthType: "single", meters: 63, bodyColor: "R", borderColor: "G", loomId: t.id });
  assert.equal(r.status, 400);
}));

// ---------------------------------------------------------------- warp type: tana vs polyester / other
const warpCard = name => ui.js(`return [...document.querySelectorAll('#view-warps [data-item]')].find(c => c.textContent.includes(${JSON.stringify(name)})).innerText.replace(/\\s+/g,' ')`);

test("warp type: Tana has one optional colour; Polyester / other has two optional colours", scenario(ui, async () => {
  await ui.tab("warps");
  await ui.clickText("+ Add warp");
  await ui.waitDialog("warpDialog");
  await ui.select("warpWidth", "Single");
  assert.equal(await ui.js("return document.querySelector('input[name=warpType]:checked').value"), "tana", "Tana is the default");
  assert.equal(await ui.visible("#warpBorderBox"), false, "Tana has a single colour");
  assert.deepEqual(await ui.js("return [warpBody.required, warpBorder.required]"), [false, false], "colours are optional");
  assert.match(await ui.text("#warpBodyLabel"), /Colour \(optional\)/);
  // Tana with no colour at all is accepted
  await ui.type("warpName", "TN-1");
  await ui.type("warpQty", "63");
  await ui.submit("warpForm");
  await ui.waitText("#view-warps", "TN-1");
  assert.match(await warpCard("TN-1"), /Single width · No colour · 63 m/);
  assert.deepEqual(await ui.db("[db.warps[0].warpType, db.warps[0].bodyColor, db.warps[0].borderColor]"), ["tana", "", ""]);
  // Polyester / other: two colours, both optional
  await ui.clickText("+ Add warp");
  await ui.waitDialog("warpDialog");
  await ui.radio("warpType", "other");
  assert.equal(await ui.visible("#warpBorderBox"), true, "a border colour appears");
  assert.deepEqual(await ui.js("return [warpBody.required, warpBorder.required]"), [false, false]);
  assert.match(await ui.text("#warpBodyLabel"), /Body colour \(optional\)/);
  assert.match(await ui.text("#warpBorderBox"), /Border colour \(optional\)/);
  await ui.type("warpName", "PO-1");
  await ui.submit("warpForm");
  await ui.waitText("#view-warps", "PO-1");
  assert.match(await warpCard("PO-1"), /Polyester \/ other · Single width · No colour · 63 m/);
  assert.deepEqual(await ui.db("[db.warps[0].warpType, db.warps[0].bodyColor, db.warps[0].borderColor]"), ["other", "", ""]);
}));

test("warp type: colours are saved as entered, and the form goes back to Tana after saving", scenario(ui, async () => {
  await ui.clickText("+ Add warp");
  await ui.waitDialog("warpDialog");
  assert.equal(await ui.js("return document.querySelector('input[name=warpType]:checked').value"), "tana", "reset to Tana after the last save");
  assert.equal(await ui.visible("#warpBorderBox"), false);
  // a Tana warp with its one colour
  await ui.type("warpName", "TN-2"); await ui.type("warpQty", "63"); await ui.type("warpBody", "Red");
  await ui.submit("warpForm");
  await ui.waitText("#view-warps", "TN-2");
  const tana = await warpCard("TN-2");
  assert.match(tana, /Single width · Red · 63 m/);
  assert.ok(!/Polyester/.test(tana));
  assert.deepEqual(await ui.db("[db.warps[0].bodyColor, db.warps[0].borderColor]"), ["Red", ""]);
  // a Polyester warp with both colours
  await ui.clickText("+ Add warp");
  await ui.waitDialog("warpDialog");
  await ui.radio("warpType", "other");
  await ui.type("warpName", "PO-2"); await ui.type("warpQty", "63"); await ui.type("warpBody", "White"); await ui.type("warpBorder", "Maroon");
  await ui.submit("warpForm");
  await ui.waitText("#view-warps", "PO-2");
  assert.match(await warpCard("PO-2"), /Polyester \/ other · Single width · White \/ Maroon · 63 m/);
  assert.deepEqual(await ui.db("[db.warps[0].bodyColor, db.warps[0].borderColor]"), ["White", "Maroon"]);
  // a Polyester warp with only one of them
  await ui.clickText("+ Add warp");
  await ui.waitDialog("warpDialog");
  await ui.radio("warpType", "other");
  await ui.type("warpName", "PO-3"); await ui.type("warpQty", "63"); await ui.type("warpBorder", "Gold");
  await ui.submit("warpForm");
  await ui.waitText("#view-warps", "PO-3");
  assert.match(await warpCard("PO-3"), /Polyester \/ other · Single width · Gold · 63 m/);
}));
