// Expenses (factory and loom sections, own categories) and the party delivery & payment report.
// Data is seeded through the API; every check and action on the page goes through the UI.
const { test, before, after } = require("node:test");
const { launch, scenario, assert, sleep } = require("../lib");
const { runningLoom, dispatch } = require("../../tests/helpers");

let ui, app, stop, f, a, party, design, loom;
const today = new Date().toISOString().slice(0, 10);
const plusDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

before(async () => {
  ({ ui, app, stop } = await launch());
  f = await app.newFactory({ modules: { stock: true, wages: true } }, "Report Mills");
  a = f.api;
  party = (await a.post("/api/clients", { name: "Sri Lakshmi Silks", address: "Erode" })).body;
  design = (await a.post("/api/designs", { number: "D-7", rate: 100 })).body;
  await a.put(`/api/clients/${party.id}`, { name: party.name, address: "Erode", rates: { [design.id]: 1200 } });
  ({ loom } = await runningLoom(a, { name: "Loom 01", warpName: "W-7", meters: 100 }));
  const staff = (await a.post("/api/staff", { name: "Ravi" })).body;
  await a.post(`/api/looms/${loom.id}/setup`, { designId: design.id, staffId: staff.id });
  await dispatch(a, loom.id, 6);
  // factory has no Process section by default, so dispatched sarees are in stock straight away
  await a.post("/api/stock/move", { from: "stock", to: "dispatched", qty: 3, clientId: party.id, designId: design.id, lrNumber: "LR-7001" });
  await a.post("/api/stock/move", { from: "dispatched", to: "stock", qty: 1, clientId: party.id, designId: design.id });
  await a.post(`/api/clients/${party.id}/payments`, { amount: 1000, mode: "Cash", date: today, note: "part payment" });
  await ui.login();
  await ui.switchFactory("Report Mills");
});
after(async () => { assert.deepEqual(await ui.jsErrors(), [], "page JavaScript errors"); await stop(); });

// ---------------------------------------------------------------- party delivery & payment report
test("report: every delivery, return and payment by date with the balance after each", scenario(ui, async () => {
  await ui.tab("parties");
  await ui.clickText("Delivery report");
  await ui.waitDialog("partyReportDialog");
  await ui.select("prParty", "Sri Lakshmi Silks");
  await ui.submit("partyReportForm");
  await ui.waitVisible("#sheetView");
  const sheet = await ui.text("#sheetPage");
  assert.match(sheet, /Delivery & payment report/i);
  assert.match(sheet, /All dates/);
  assert.match(sheet, /Sri Lakshmi Silks/);
  assert.match(sheet, /Delivery\s+Design D-7 · LR LR-7001\s+3\s+₹1,200\s+₹3,600/);
  assert.match(sheet, /Return .*1/);
  assert.match(sheet, /Payment\s+Cash · part payment\s+.*₹1,000/);
  // 3 × 1200 − 1 × 1200 − 1000 = 1400 due
  assert.match(sheet, /Total\s+2\s+₹2,400\s+₹1,000\s+₹1,400 due/);
  assert.match(sheet, /Balance\s*₹1,400 due/i);
  assert.ok(await ui.exists("#sheetView button"), "print / Excel buttons are there");
  await ui.clickText("Close", "#sheetView");
}));

test("report: a start date turns earlier entries into a balance brought forward", scenario(ui, async () => {
  await ui.clickText("Delivery report");
  await ui.waitDialog("partyReportDialog");
  await ui.select("prParty", "Sri Lakshmi Silks");
  await ui.setValue("prFrom", plusDays(1));
  await ui.submit("partyReportForm");
  await ui.waitVisible("#sheetView");
  const sheet = await ui.text("#sheetPage");
  assert.match(sheet, /Balance brought forward\s+₹1,400 due/);
  assert.match(sheet, /No entries in this period/);
  await ui.clickText("Close", "#sheetView");
}));

test("report: a start date after the end date is refused", scenario(ui, async () => {
  await ui.clickText("Delivery report");
  await ui.waitDialog("partyReportDialog");
  await ui.setValue("prFrom", plusDays(2));
  await ui.setValue("prTo", plusDays(1));
  await ui.click("#partyReportForm button[type=submit]");
  await ui.toast("start date is after the end date");
  assert.equal(await ui.dialogOpen("partyReportDialog"), true);
  await ui.closeDialogs();
}));

test("report: the Report button on a party card opens it straight away", scenario(ui, async () => {
  await ui.clickText("Report", "#partyGrid");
  await ui.waitVisible("#sheetView");
  assert.match(await ui.text("#sheetPage"), /LR-7001/);
  await ui.clickText("Close", "#sheetView");
}));

// ---------------------------------------------------------------- expenses: factory and loom sections
test("expenses: two sections, factory and loom", scenario(ui, async () => {
  await ui.tab("expenses");
  const buttons = await ui.text("#expScopeSwitch");
  assert.match(buttons, /Factory expenses/); assert.match(buttons, /Loom expenses/);
  await ui.click('[data-exp-scope="factory"]');
  await ui.waitText("#expenseSub", /whole factory/);
  assert.equal(await ui.visible("#expLoomFilter"), false, "the loom filter is for loom expenses only");
  assert.match(await ui.text("#expAddBtn"), /Add factory expense/);
}));

test("expenses: a factory expense needs no loom and has its own categories", scenario(ui, async () => {
  await ui.click("#expAddBtn");
  await ui.waitDialog("expenseDialog");
  assert.match(await ui.text("#expenseDialogTitle"), /Add factory expense/);
  assert.equal(await ui.visible("#expLoomBox"), false);
  assert.deepEqual(await ui.options("expKind"), ["Rent", "Electricity", "Transport", "Other"]);
  await ui.select("expKind", "Rent");
  await ui.type("expAmount", "5000");
  await ui.type("expVendor", "Landlord");
  await ui.submit("expenseForm");
  await ui.toast("added for the factory");
  const row = await ui.text("#expenseTable");
  assert.match(row, /Rent/); assert.match(row, /Landlord/); assert.match(row, /₹5,000/);
  assert.match(await ui.text("#expByTitle"), /By category/);
  assert.match(await ui.text("#expCountFactory"), /\(1\)/);
}));

test("expenses: add your own category from the expense form", scenario(ui, async () => {
  await ui.click("#expAddBtn");
  await ui.waitDialog("expenseDialog");
  await ui.click("#expNewCat");
  await ui.askOk("Packing");
  await ui.toast("Category Packing added");
  assert.equal(await ui.js("return document.getElementById('expKind').selectedOptions[0].text"), "Packing", "new category is selected");
  await ui.type("expAmount", "250");
  await ui.submit("expenseForm");
  await ui.waitText("#expenseTable", "Packing");
  assert.match(await ui.text("#expenseStats"), /Packing\s+₹250/);
  assert.match(await ui.text("#expenseByLoom"), /Packing/);
}));

test("expenses: duplicate and built-in category names are refused", scenario(ui, async () => {
  await ui.click("#expCatBtn");
  await ui.waitDialog("expCatDialog");
  const list = await ui.text("#expCatList");
  for (const n of ["Rent", "Electricity", "Transport", "Other", "Packing"]) assert.match(list, new RegExp(n));
  await ui.type("expCatName", "rent");
  await ui.click("#expCatForm button[type=submit]");
  await ui.waitText("#expCatNotice", /already a factory expense category called rent/);
  await ui.type("expCatName", "Insurance");
  await ui.click("#expCatForm button[type=submit]");
  await ui.waitText("#expCatList", "Insurance");
}));

test("expenses: an unused category can be removed, a used one cannot", scenario(ui, async () => {
  const rowOf = async name => (await ui.all("#expCatList [data-cat]"))
    .find(async r => (await r.getText()).includes(name));
  // Packing is in use: refused
  await ui.js(`[...document.querySelectorAll('#expCatList [data-cat]')].find(r => r.textContent.includes('Packing')).querySelector('[data-del-cat]').click()`);
  await ui.askOk();
  await ui.waitText("#expCatNotice", /Packing is used by 1 expense/);
  // Insurance is unused: removed
  await ui.js(`[...document.querySelectorAll('#expCatList [data-cat]')].find(r => r.textContent.includes('Insurance')).querySelector('[data-del-cat]').click()`);
  await ui.askOk();
  await ui.waitFor(async () => !(await ui.text("#expCatList")).includes("Insurance"), "Insurance should be gone");
  assert.ok((await ui.text("#expCatList")).includes("Packing"));
  await ui.closeDialogs();
}));

test("expenses: a loom expense needs a loom; spares need the part; own loom category works", scenario(ui, async () => {
  await ui.click('[data-exp-scope="loom"]');
  await ui.waitText("#expenseSub", /each loom costs/);
  assert.equal(await ui.visible("#expLoomFilter"), true);
  await ui.click("#expAddBtn");
  await ui.waitDialog("expenseDialog");
  assert.match(await ui.text("#expenseDialogTitle"), /Add loom expense/);
  assert.equal(await ui.visible("#expLoomBox"), true);
  assert.deepEqual(await ui.options("expKind"), ["Warp join", "Bobbin join", "Spares", "Maintenance"]);
  // spares: extra fields, the part is required
  await ui.select("expKind", "Spares");
  assert.equal(await ui.visible("#expItem"), true);
  assert.equal(await ui.js("return document.getElementById('expItem').required"), true);
  assert.equal(await ui.visible("#expQty"), true);
  await ui.select("expLoom", "Loom 01");
  await ui.type("expAmount", "800");
  await ui.click("#expenseForm button[type=submit]");
  assert.equal(await ui.dialogOpen("expenseDialog"), true, "blocked until the spare part is named");
  await ui.type("expItem", "Shuttle");
  await ui.type("expQty", "2");
  await ui.submit("expenseForm");
  await ui.toast("added to Loom 01");
  assert.match(await ui.text("#expenseTable"), /Shuttle × 2/);

  // an own loom category, from the form: it is a plain category (no spares / warp extras)
  await ui.click("#expAddBtn");
  await ui.waitDialog("expenseDialog");
  await ui.click("#expNewCat");
  await ui.askOk("Tools");
  await ui.toast("Category Tools added");
  assert.equal(await ui.visible("#expWarpBox"), false);
  assert.equal(await ui.visible("#expQtyBox"), false);
  await ui.select("expLoom", "Loom 01");
  await ui.type("expAmount", "120");
  await ui.submit("expenseForm");
  await ui.waitText("#expenseByLoom", /Tools/i);
  // the factory section did not get the loom category
  await ui.click('[data-exp-scope="factory"]');
  assert.ok(!(await ui.text("#expenseStats")).includes("Tools"));
  assert.ok((await ui.text("#expenseStats")).includes("Packing"));
}));

test("expenses: edit keeps the section; the filters narrow the list", scenario(ui, async () => {
  await ui.click('[data-exp-scope="factory"]');
  await ui.js(`[...document.querySelectorAll('#expenseTable tr[data-exp]')].find(r => r.textContent.includes('Rent')).querySelector('[data-edit-exp]').click()`);
  await ui.waitDialog("expenseDialog");
  assert.match(await ui.text("#expenseDialogTitle"), /Edit factory expense/);
  await ui.type("expAmount", "5200");
  await ui.submit("expenseForm");
  await ui.waitText("#expenseTable", "₹5,200");
  await ui.select("expKindFilter", "Packing");
  const t = await ui.text("#expenseTable");
  assert.match(t, /Packing/); assert.ok(!t.includes("Rent"));
  await ui.select("expKindFilter", "All categories");
  await ui.type("expSearch", "landlord");
  const s = await ui.text("#expenseTable");
  assert.match(s, /Rent/); assert.ok(!s.includes("Packing"));
  await ui.type("expSearch", "");
}));

test("expenses: the report follows the section and the category list", scenario(ui, async () => {
  await ui.clickText("Report");
  await ui.waitDialog("expReportDialog");
  assert.match(await ui.text("#expReportTitle"), /Factory expense report/);
  assert.equal(await ui.visible("#expRepLoomBox"), false);
  await ui.select("expRepPeriod", "month");
  await ui.submit("expReportForm");
  await ui.waitVisible("#sheetView");
  const sheet = await ui.text("#sheetPage");
  assert.match(sheet, /factory expense report/i);
  assert.match(sheet, /By category/i);
  assert.match(sheet, /Rent\s+1\s+₹5,200/);
  assert.match(sheet, /Packing\s+1\s+₹250/);
  assert.match(sheet, /Total spent\s*₹5,450/i);
  await ui.clickText("Close", "#sheetView");

  await ui.click('[data-exp-scope="loom"]');
  await ui.clickText("Report");
  await ui.waitDialog("expReportDialog");
  assert.equal(await ui.visible("#expRepLoomBox"), true);
  await ui.select("expRepPeriod", "month");
  await ui.submit("expReportForm");
  await ui.waitVisible("#sheetView");
  const loomSheet = await ui.text("#sheetPage");
  assert.match(loomSheet, /By loom/i);
  assert.match(loomSheet, /Loom 01/);
  assert.match(loomSheet, /Shuttle × 2/);
  assert.match(loomSheet, /Total spent\s*₹920/i);
  await ui.clickText("Close", "#sheetView");
}));

test("expenses: a factory expense is logged and shows in the log without a loom", scenario(ui, async () => {
  await ui.tab("log");
  const log = await ui.text("#view-log");
  assert.match(log, /Expense added: Rent ₹5,000 for the factory/);
  assert.match(log, /Expense category Packing added \(factory\)/);
  assert.match(log, /Expense added: Spares ₹800 on Loom 01/);
}));
