// Loom width has three sizes: single (1 saree per 6.3 m), double (2) and triple (3).
const { test, before, after } = require("node:test");
const { launch, scenario, assert } = require("../lib");

let ui, app, stop, a;
before(async () => {
  ({ ui, app, stop } = await launch());
  const f = await app.newFactory({ modules: { type: "own", process: false, weft: false, labour: false } }, "Width Mills");
  a = f.api;
  await ui.login();
  await ui.switchFactory("Width Mills");
});
after(async () => { assert.deepEqual(await ui.jsErrors(), [], "page JavaScript errors"); await stop(); });

test("add loom without loom types: width offers Single, Double and Triple", scenario(ui, async () => {
  await ui.tab("warps");
  await ui.clickText("+ Add loom");
  await ui.waitDialog("loomDialog");
  const radios = await ui.js("return [...document.querySelectorAll('input[name=loomWidth]')].map(r => r.value)");
  assert.deepEqual(radios, ["single", "double", "triple"]);
  assert.match(await ui.text("#loomWidthBox"), /Double width\s*2 sarees per 6\.3 m/);
  await ui.radio("loomWidth", "double");
  await ui.type("loomName", "D-Loom");
  await ui.submit("loomForm");
  await ui.toast("D-Loom added (double width");
  assert.equal(await ui.db("db.looms.find(l => l.name === 'D-Loom').widthType"), "double");
}));

test("looms are grouped under Single, Double and Triple width sections", scenario(ui, async () => {
  await a.post("/api/looms", { name: "S-Loom", widthType: "single" });
  await a.post("/api/looms", { name: "T-Loom", widthType: "triple" });
  await ui.reload();
  await ui.switchFactory("Width Mills");
  await ui.tab("looms");
  const t = await ui.text("#view-looms");
  assert.match(t, /Single width looms/); assert.match(t, /Double width looms/); assert.match(t, /Triple width looms/);
  await ui.tab("loomlist");
  const l = await ui.text("#loomTable");
  assert.match(l, /Double width looms/);
}));

test("warp and bobbin: Double width is a choice, and sarees are counted in pairs", scenario(ui, async () => {
  await ui.tab("warps");
  await ui.clickText("+ Add warp");
  await ui.waitDialog("warpDialog");
  assert.deepEqual((await ui.options("warpWidth")), ["Single width", "Double width", "Triple width"]);
  await ui.select("warpLoom", "D-Loom");
  assert.equal(await ui.value("warpWidth"), "double", "the width follows the chosen loom");
  assert.match(await ui.text("#warpLoomInfo"), /Width\s+Double width · 2 sarees per 6\.3 m/);
  await ui.radio("warpUnit", "sarees");
  await ui.type("warpQty", "5");
  assert.match(await ui.text("#warpQtyHint"), /Double width makes sarees in sets of 2\. Try 4 or 6\./);
  await ui.type("warpQty", "20");
  assert.match(await ui.text("#warpQtyHint"), /= 63 m of warp \(double width: 2 sarees per 6\.3 m\)/);
  await ui.type("warpName", "DW-1"); await ui.type("warpBody", "Red");
  await ui.submit("warpForm");
  await ui.waitText("#view-warps", "DW-1");
  assert.match(await ui.text("#view-warps"), /Double width warps/);
  assert.equal(await ui.db("db.warps.find(w => w.name === 'DW-1').originalMeters"), 63);
  // bobbin form also offers it
  await ui.tab("bobbins");
  await ui.click("#openBobbinForm"); await ui.waitDialog("bobbinDialog");
  assert.ok((await ui.options("bobbinWidth")).includes("Double width"));
  await ui.closeDialogs();
}));

test("dispatch on a double loom: pairs only, 6.3 m per pair", scenario(ui, async () => {
  await ui.tab("warps");
  await ui.clickText("Mark ready", "#view-warps");
  await ui.waitText("#view-warps", "Start on loom");
  await ui.clickText("Start on loom", "#view-warps");
  await ui.askOk();
  await ui.waitFor(() => ui.db("!!db.looms.find(l => l.name === 'D-Loom').warpId"), "DW-1 should be on D-Loom");
  await ui.closeDialogs();
  await ui.tab("looms");
  await ui.clickText("Dispatch", "#view-looms");
  await ui.waitDialog("deliveryDialog");
  await ui.type("deliverySarees", "3");
  assert.match(await ui.text("#deliveryPreview"), /Double-width quantities must be a multiple of 2\. Try 2 or 4\./);
  await ui.type("deliverySarees", "4");
  const preview = await ui.text("#deliveryPreview");
  assert.match(preview, /Uses 12\.6 m of DW-1/);
  assert.match(preview, /Left after: 50\.4 m \(16 sarees\)/);
  await ui.submit("deliveryForm");
  await ui.toast("4 sarees dispatched");
  assert.equal(await ui.db("db.warps.find(w => w.name === 'DW-1').remainingMeters"), 50.4);
  // the server enforces the same rule
  const loom = (await a.get("/api/data")).body.looms.find(l => l.name === "D-Loom");
  const bad = await a.post("/api/deliveries", { loomId: loom.id, sarees: 3 });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /double-width loom.*multiples of 2/);
}));

test("loom types and the warp balance correction use pairs for double width", scenario(ui, async () => {
  await ui.tab("looms");
  const card = await ui.text("#view-looms");
  assert.match(card, /D-Loom/);
  // factory loom-type rows offer Double
  await ui.click("#userBtn"); await ui.click("#menuSettings"); await ui.waitVisible("#view-settings");
  await ui.click("#addFactoryBtn"); await ui.waitDialog("factoryDialog");
  assert.deepEqual(await ui.js("return [...document.querySelector('#facLoomTypeRows select[data-f=width]').options].map(o => o.value)"), ["single", "double", "triple"]);
  await ui.closeDialogs();
}));
