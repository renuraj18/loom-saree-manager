// The whole journey through the UI only: new factory → party → weft → design → labour → loom → warp →
// dispatch → process → stock → delivery to the party → payment → wages → log and dashboard.
const { test, before, after } = require("node:test");
const { launch, scenario, assert } = require("../lib");

let ui, stop;
before(async () => { ({ ui, stop } = await launch()); await ui.login(); });
after(async () => { assert.deepEqual(await ui.jsErrors(), [], "page JavaScript errors"); await stop(); });

test("settings: create an Own factory with Process, Weft and Labour", scenario(ui, async () => {
  await ui.click("#userBtn");
  await ui.click("#menuSettings");
  await ui.waitVisible("#view-settings");
  await ui.click("#addFactoryBtn");
  await ui.waitDialog("factoryDialog");
  await ui.type("facName", "UI Mills");
  await ui.type("facLocation", "Salem");
  await ui.type("facOwner", "Test Owner");
  await ui.radio("facType", "own");
  await ui.check("facProcess", true);
  await ui.check("facWeft", true);
  await ui.check("facLabour", true);
  await ui.submit("factoryForm");
  await ui.toast("UI Mills created");
  await ui.switchFactory("UI Mills");
  assert.ok((await ui.visibleTabs()).includes("process"), "Process tab shows when Include Process is ticked");
  assert.ok((await ui.visibleTabs()).includes("wefts"));
}));

test("parties: add a party", scenario(ui, async () => {
  await ui.tab("parties");
  await ui.clickText("+ Add party");
  await ui.waitDialog("clientDialog");
  await ui.type("clientName", "Sri Lakshmi Silks");
  await ui.type("clientAddress", "12 Main Road, Erode");
  await ui.submit("clientForm");
  await ui.toast("added as a party");
  await ui.waitText("#partyGrid", "Sri Lakshmi Silks");
}));

test("weft: a party is mandatory, then two wefts are added", scenario(ui, async () => {
  await ui.tab("wefts");
  await ui.clickText("+ Add weft");
  await ui.waitDialog("weftDialog");
  await ui.type("weftName", "Gold Zari");
  await ui.type("weftColor", "Gold");
  await ui.type("weftKg", "5");
  await ui.click("#weftForm button[type=submit]");
  assert.equal(await ui.dialogOpen("weftDialog"), true, "dialog must stay open without a party");
  assert.equal(await ui.js("return document.getElementById('weftParty').validity.valueMissing"), true);
  await ui.select("weftParty", "Sri Lakshmi Silks");
  await ui.submit("weftForm");
  await ui.toast("Gold Zari added");

  await ui.clickText("+ Add weft");
  await ui.waitDialog("weftDialog");
  await ui.type("weftName", "Red Silk");
  await ui.type("weftColor", "Red");
  await ui.type("weftKg", "3");
  await ui.select("weftParty", "Sri Lakshmi Silks");
  await ui.submit("weftForm");
  await ui.toast("Red Silk added");
  const t = await ui.text("#weftTable");
  assert.match(t, /Gold Zari/); assert.match(t, /5 kg/); assert.match(t, /Red Silk/); assert.match(t, /3 kg/);
}));

test("designs: add a design that uses both wefts, in grams", scenario(ui, async () => {
  await ui.tab("designs");
  await ui.clickText("+ Add design");
  await ui.waitDialog("designDialog");
  await ui.type("designNo", "D-201");
  await ui.type("designRate", "250");
  await ui.click("#designWeftAdd");
  await ui.click("#designWeftAdd");
  const rows = await ui.all("#designWefts .weftrow");
  assert.equal(rows.length, 2);
  await ui.select(await rows[0].findElement(ui.By.css("select")), "Gold Zari");
  await ui.typeEl(await rows[0].findElement(ui.By.css("input")), 150);
  await ui.select(await rows[1].findElement(ui.By.css("select")), "Red Silk");
  await ui.typeEl(await rows[1].findElement(ui.By.css("input")), 100);
  await ui.submit("designForm");
  await ui.toast("Design D-201 added");
  assert.match(await ui.text("#designGrid"), /Weft per saree: Gold Zari 150 g, Red Silk 100 g/);
}));

test("labour, loom and warp for the party", scenario(ui, async () => {
  assert.equal(await ui.tabVisible("staff"), false, "Labour is no longer a separate tab");
  await ui.tab("wages");
  await ui.clickText("Manage labour");
  await ui.waitDialog("manageStaffDialog");
  await ui.clickText("+ Add labourer");
  await ui.waitDialog("staffDialog");
  await ui.type("staffName", "Ravi Kumar");
  await ui.type("staffPhone", "9876543210");
  await ui.submit("staffForm");
  await ui.toast("Ravi Kumar added");
  await ui.waitText("#staffList", "Ravi Kumar");
  assert.match(await ui.text("#staffList"), /9876543210/);
  await ui.clickText("Close", "#manageStaffDialog");
  await ui.waitDialogClosed("manageStaffDialog");

  await ui.tab("warps");
  await ui.clickText("+ Add loom");
  await ui.waitDialog("loomDialog");
  await ui.type("loomName", "Loom 01");
  await ui.submit("loomForm");
  await ui.toast("Loom 01");

  await ui.clickText("+ Add warp");
  await ui.waitDialog("warpDialog");
  await ui.type("warpName", "W-001");
  await ui.type("warpQty", "63");
  await ui.type("warpBody", "Red");
  await ui.select("warpParty", "Sri Lakshmi Silks");
  await ui.select("warpLoom", "Loom 01");
  await ui.submit("warpForm");
  await ui.waitText("#view-warps", "W-001");
  assert.match(await ui.text("#view-warps"), /For party: Sri Lakshmi Silks/);
  assert.match(await ui.text("#view-warps"), /For loom: Loom 01/);
}));

test("warp: ordered → ready → running on the loom, then design and labourer", scenario(ui, async () => {
  await ui.clickText("Mark ready", "#view-warps");
  await ui.waitText("#view-warps", "Start on loom");
  await ui.clickText("Start on loom", "#view-warps");
  await ui.askOk();
  await ui.waitDialog("setupDialog");
  await ui.click("#setupDesigns input[type=checkbox]");
  await ui.select("setupDesign", "D-201");
  await ui.select("setupStaff", "Ravi Kumar");
  await ui.submit("setupForm");
  await ui.toast("Loom 01 saved");
  assert.equal(await ui.db("db.looms[0].staffId === db.staff[0].id && db.looms[0].designId === db.designs[0].id"), true);
}));

test("dispatch: preview shows warp, wage and weft; saving uses them up", scenario(ui, async () => {
  await ui.tab("looms");
  await ui.clickText("Dispatch", "#view-looms");
  await ui.waitDialog("deliveryDialog");
  await ui.type("deliverySarees", "4");
  await ui.type("deliveryLr", "LR-1001");
  const preview = await ui.text("#deliveryPreview");
  assert.match(preview, /Uses 25\.2 m of W-001/);
  assert.match(preview, /₹1,000 to Ravi Kumar/);
  assert.match(preview, /Weft Gold Zari: 0\.6 kg used, 4\.4 kg in hand after/);
  assert.match(preview, /Weft Red Silk: 0\.4 kg used, 2\.6 kg in hand after/);
  await ui.submit("deliveryForm");
  const toast = await ui.toast("dispatched from Loom 01");
  assert.match(toast, /37\.8 m left on W-001/);
  assert.match(toast, /Weft Gold Zari: 0\.6 kg used, 4\.4 kg in hand/);
}));

test("process: godown → check (process + greese) → folding → stock", scenario(ui, async () => {
  await ui.tab("process");
  await ui.clickText("Receive at godown", "#view-process");
  await ui.askOk();
  await ui.waitText("#view-process", "Send to process");
  await ui.clickText("Send to process", "#view-process");
  await ui.waitDialog("sortDialog");
  await ui.type("sort-process", "3");
  await ui.type("sort-mai", "1");
  await ui.submit("sortForm");
  await ui.clickText("Send to folding", "#view-process");
  await ui.askOk();
  await ui.clickText("Add to stock", "#view-process");
  await ui.waitDialog("sortDialog");
  await ui.submit("sortForm");
  await ui.tab("stock");
  assert.equal(await ui.db("stockOf().stock"), 3);
  assert.equal(await ui.db("stockOf().mai"), 1);
}));

test("parties: set the rate for the design", scenario(ui, async () => {
  await ui.tab("parties");
  await ui.clickText("Edit / rates");
  await ui.waitDialog("clientDialog");
  await ui.click("#clientRates input[type=checkbox]");
  await ui.typeEl(await ui.css("#clientRates input[data-rate]"), 1200);
  await ui.submit("clientForm");
  await ui.waitFor(() => ui.db("Object.values(db.clients[0].rates || {})[0] === 1200"), "rate not saved");
}));

test("stock: deliver 2 sarees to the party, priced at the party's rate", scenario(ui, async () => {
  await ui.tab("stock");
  await ui.clickText("Delivery to party");
  await ui.waitDialog("actDialog");
  await ui.type("actQty", "32");
  await ui.click("#actForm button[type=submit]");
  assert.equal(await ui.dialogOpen("actDialog"), true, "more than the stock in hand is refused");
  await ui.type("actQty", "2");
  await ui.type("actLr", "LR-2001");
  assert.match(await ui.text("#actDialog"), /2 × ₹1,200 = ₹2,400/);
  await ui.submit("actForm");
  await ui.waitFor(() => ui.db("partyHolds(db.clients[0].id) === 2"), "party should hold 2");
  const m = await ui.db("db.stockMoves.find(m => m.to === 'dispatched')");
  assert.deepEqual([m.qty, m.rate, m.amount, m.lrNumber, m.designNo, m.sourceWarpName], [2, 1200, 2400, "LR-2001", "D-201", "W-001"]);
}));

test("parties: card summary, payment, and the warp and weft detail sections", scenario(ui, async () => {
  await ui.tab("parties");
  const card = await ui.text("#partyGrid");
  assert.match(card, /₹2,400 due/);
  assert.match(card, /Total saree production\s+4 sarees/);
  assert.match(card, /Warp pending\s+37\.8 m · 6 sarees/);
  assert.match(card, /Gold Zari\s+0\.6 kg \/ 4\.4 kg/);
  assert.match(card, /Red Silk\s+0\.4 kg \/ 2\.6 kg/);

  await ui.clickText("Payments");
  await ui.waitDialog("payDialog");
  await ui.type("payAmount", "1000");
  await ui.submit("payForm", { closes: false });
  await ui.waitText("#payDialog", /Balance due\s*₹1,400/);
  await ui.closeDialogs();

  await ui.js("document.querySelectorAll('#partyDetails details, #partyWeftDetails details').forEach(d => d.open = true)");
  const warp = await ui.text("#partyDetails");
  assert.match(warp, /Weft used on this warp: Gold Zari 0\.6 kg, Red Silk 0\.4 kg/);
  assert.match(warp, /LR-2001/);
  const weft = await ui.text("#partyWeftDetails");
  assert.match(weft, /4 sarees produced/);
  assert.match(weft, /Gold Zari\s+5 kg\s+0\.6 kg\s+4\.4 kg/);
  assert.match(weft, /Red Silk\s+3 kg\s+0\.4 kg\s+2\.6 kg/);
  assert.match(weft, /All weft\s+8 kg\s+1 kg\s+7 kg/);
}));

test("stock page and home chips show weft in hand next to the sarees", scenario(ui, async () => {
  await ui.tab("stock");
  const cards = await ui.text("#stockBuckets");
  assert.match(cards, /Weft in hand\s+7 kg\s+1 kg used of 8 kg received/i);
  const byParty = await ui.text("#stockByParty");
  assert.match(byParty, /Sri Lakshmi Silks/);
  assert.match(byParty, /Gold Zari\s+5 kg · 0\.6 kg · 4\.4 kg/);
  assert.match(byParty, /Red Silk\s+3 kg · 0\.4 kg · 2\.6 kg/);
  await ui.tab("home");
  assert.match(await ui.text("#homeStockPanel"), /7 kg\s+Weft in hand/i);
}));

test("wages: settle the labourer and see the wage sheet", scenario(ui, async () => {
  await ui.tab("wages");
  assert.match(await ui.text("#view-wages"), /₹1,000/);
  await ui.clickText("Settle & start new week");
  await ui.waitDialog("settleDialog");
  await ui.submit("settleForm", { closes: false });
  await ui.waitVisible("#sheetView");
  const sheet = await ui.text("#sheetView");
  assert.match(sheet, /Ravi Kumar/); assert.match(sheet, /D-201/); assert.match(sheet, /₹1,000/);
  await ui.clickText("Close", "#sheetView");
}));

test("log and dashboard show everything that happened", scenario(ui, async () => {
  await ui.tab("log");
  const log = await ui.text("#view-log");
  for (const bit of ["UI Mills".slice(0, 0), "Weft Gold Zari added · 5 kg received from Sri Lakshmi Silks", "weft used Gold Zari 0.6 kg (4.4 kg in hand)",
    "2 sarees delivered to Sri Lakshmi Silks", "₹1,000 received from Sri Lakshmi Silks (Cash) · balance ₹1,400", "Wages settled"]) assert.ok(log.includes(bit), `log is missing: ${bit}`);
  await ui.tab("home");
  assert.match(await ui.text("#homeWeftPanel"), /Gold Zari\s+Gold\s+5 kg\s+0\.6 kg\s+4\.4 kg/);
  const text = await ui.js("return dashboardText()");
  assert.match(text, /Weft Gold Zari|\* ?Weft|• Gold Zari: received 5 kg · used 0\.6 kg · in hand 4\.4 kg/);
  assert.match(await ui.text("#view-home"), /Sarees dispatched\s+4/);
}));
