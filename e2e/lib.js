// Shared helpers for the Selenium suite: starts the real server (throwaway data folder, same helper
// the API tests use), drives Chrome, and wraps the page's controls (dialogs, tabs, selects, toasts).
// Run with `npm run test:e2e` (see e2e/README.md). Set HEADED=1 to watch the browser.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { Builder, By, Key, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const { startApp } = require("../tests/helpers");

const WAIT = 8000;
const ARTIFACTS = path.join(__dirname, "artifacts");
const sleep = ms => new Promise(r => setTimeout(r, ms));

class UI {
  constructor(driver, app) { this.d = driver; this.app = app; this.By = By; }

  // ---- finding things ----
  $(id) { return this.d.findElement(By.id(id)); }
  css(sel) { return this.d.findElement(By.css(sel)); }
  all(sel) { return this.d.findElements(By.css(sel)); }
  async exists(sel) { return (await this.all(sel)).length > 0; }
  async visible(sel) { const els = await this.all(sel); return els.length > 0 && els[0].isDisplayed(); }
  async waitVisible(sel, ms = WAIT) { const el = await this.d.wait(until.elementLocated(By.css(sel)), ms); await this.d.wait(until.elementIsVisible(el), ms); return el; }
  async waitGone(sel, ms = WAIT) { await this.d.wait(async () => !(await this.visible(sel)), ms, `${sel} is still visible`); }
  async waitFor(fn, msg, ms = WAIT) { await this.d.wait(async () => { try { return await fn(); } catch { return false; } }, ms, msg); }
  js(script, ...args) { return this.d.executeScript(script, ...args); }
  async text(sel) { return (await this.d.findElement(By.css(sel)).getText()).replace(/\s+/g, " ").trim(); }
  async pageText(sel = "body") { return this.text(sel); }
  async waitText(sel, re, ms = WAIT) {
    await this.waitFor(async () => (re instanceof RegExp ? re.test(await this.text(sel)) : (await this.text(sel)).includes(re)), `${sel} never matched ${re}`, ms);
  }

  // ---- clicking and typing ----
  async click(target) {
    const el = typeof target === "string" ? await this.d.wait(until.elementLocated(By.css(target)), WAIT) : target;
    await this.js("arguments[0].scrollIntoView({block:'center'})", el);
    try { await el.click(); } catch { await this.js("arguments[0].click()", el); }
  }
  // Clicks the first visible button / link whose text contains `text`, inside `scope` (a css selector;
  // defaults to the open dialog, else the page).
  async clickText(text, scope) {
    const el = await this.d.wait(async () => this.js(`
      const [text, scope] = arguments;
      const root = scope ? document.querySelector(scope) : (document.querySelector("dialog[open]") || document);
      if (!root) return null;
      const items = [...root.querySelectorAll("button, a, summary, [role=button]")];
      return items.find(b => b.offsetParent !== null && !b.disabled && b.textContent.replace(/\\s+/g, " ").trim().includes(text)) || null;
    `, text, scope || null), WAIT, `no button "${text}"`);
    await this.click(el);
  }
  async type(id, value) {
    const el = await this.$(id);
    await this.js("arguments[0].scrollIntoView({block:'center'})", el);
    await el.clear();
    if (String(value) !== "") await el.sendKeys(String(value));
    await this.js("arguments[0].dispatchEvent(new Event('input',{bubbles:true}));arguments[0].dispatchEvent(new Event('change',{bubbles:true}))", el);
  }
  // For date / colour inputs, which sendKeys handles badly.
  async setValue(id, value) {
    await this.js("const e=document.getElementById(arguments[0]);e.value=arguments[1];e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))", id, value);
  }
  // Picks the option whose text contains `label` (or whose value equals it). `target` is an id or an element.
  async select(target, label) {
    const el = typeof target === "string" ? await this.$(target) : target;
    const ok = await this.js(`
      const s = arguments[0], label = arguments[1];
      const o = [...s.options].find(o => o.value === label) || [...s.options].find(o => o.text.replace(/\\s+/g, " ").includes(label));
      if (!o) return [...s.options].map(o => o.text);
      s.value = o.value; s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); return true;`, el, label);
    assert.equal(ok, true, `${typeof target === "string" ? "#" + target : "select"} has no option "${label}" (options: ${JSON.stringify(ok)})`);
  }
  // Sets a number / text field given as an element.
  async typeEl(el, value) {
    await el.clear(); await el.sendKeys(String(value));
    await this.js("arguments[0].dispatchEvent(new Event('input',{bubbles:true}));arguments[0].dispatchEvent(new Event('change',{bubbles:true}))", el);
  }
  async value(id) { return this.js("return document.getElementById(arguments[0]).value", id); }
  async options(id) { return this.js("return [...document.getElementById(arguments[0]).options].map(o => o.text.replace(/\\s+/g,' ').trim())", id); }
  async radio(name, value) { await this.js("const r=document.querySelector(`input[name=\"${arguments[0]}\"][value=\"${arguments[1]}\"]`); r.closest('label').click()", name, value); }
  async check(id, on = true) { const el = await this.$(id); if ((await el.isSelected()) !== on) await this.js("arguments[0].click()", el); }

  // ---- dialogs, forms, toasts ----
  async dialogOpen(id) { return this.js("return document.getElementById(arguments[0]).open", id); }
  async waitDialog(id) { await this.waitFor(() => this.dialogOpen(id), `dialog #${id} did not open`); }
  async waitDialogClosed(id) { await this.waitFor(async () => !(await this.dialogOpen(id)), `dialog #${id} did not close`); }
  async openDialogs() { return this.js("return [...document.querySelectorAll('dialog[open]')].map(d => d.id)"); }
  async closeDialogs() { await this.js("document.querySelectorAll('dialog[open]').forEach(d => d.close())"); }
  // Clicks the submit button of a form and (by default) waits for its dialog to close.
  async submit(formId, { closes = true } = {}) {
    await this.click(`#${formId} button[type=submit]`);
    if (closes) {
      const dlg = await this.js("return document.getElementById(arguments[0]).closest('dialog').id", formId);
      await this.waitDialogClosed(dlg);
    }
  }
  async notice(id) { return this.text(`#${id}`); }
  async toast(re) { await this.waitFor(async () => { const t = await this.text("#toast"); return re instanceof RegExp ? re.test(t) : t.includes(re); }, `toast never matched ${re}`); return this.text("#toast"); }
  // Answers the generic ask() dialog.
  async askOk(value) {
    await this.waitDialog("askDialog");
    if (value !== undefined) await this.type("askInput", value);
    await this.click("#askOk");
    await this.waitDialogClosed("askDialog");
  }
  async askText() { await this.waitDialog("askDialog"); return this.text("#askDialog"); }
  async askCancel() { await this.clickText("Cancel", "#askDialog"); await this.waitDialogClosed("askDialog"); }

  // ---- app navigation ----
  async home() { await this.d.get(this.app.url + "/"); await this.waitVisible("#loginForm, #userBtn"); }
  async login(username = "admin", password = "admin") {
    await this.home();
    if (!(await this.visible("#loginForm"))) return;
    await this.type("loginUser", username);
    await this.type("loginPass", password);
    await this.click("#loginForm button[type=submit]");
    await this.waitVisible("#userBtn");
    await this.waitFor(() => this.js("return typeof session !== 'undefined' && !!session.user"), "session not loaded");
  }
  async reload() { await this.d.navigate().refresh(); await this.waitVisible("#userBtn"); await this.waitFor(() => this.js("return typeof db !== 'undefined' && !!db && Array.isArray(db.looms)"), "data not loaded"); }
  async signOut() { await this.click("#userBtn"); await this.click('[data-menu="signout"]'); await this.waitVisible("#loginForm"); }
  async tab(name) {
    await this.js("document.querySelector(`nav.tabs a[href=\"#${arguments[0]}\"]`).click()", name);
    await this.waitFor(() => this.visible(`#view-${name}`), `view ${name} is not visible`);
  }
  async tabVisible(name) { return this.js("const t=document.querySelector(`nav.tabs a[href=\"#${arguments[0]}\"]`);return !!t && t.offsetParent!==null", name); }
  async visibleTabs() { return this.js("return [...document.querySelectorAll('nav.tabs a')].filter(t=>t.offsetParent!==null).map(t=>t.getAttribute('href').slice(1))"); }
  async switchFactory(name) {
    await this.select("factorySelect", name);
    await this.waitFor(() => this.js("return (session.factories.find(f=>f.id===currentFactoryId)||{}).name===arguments[0]", name), `did not switch to ${name}`);
    await sleep(400);
    await this.waitFor(() => this.js("return typeof db !== 'undefined' && !!db && Array.isArray(db.looms)"), "data not loaded");
  }
  // Data the page holds, e.g. ui.db("db.looms.length").
  db(expr) { return this.js(`return ${expr}`); }
  async resize(w, h) { await this.d.manage().window().setRect({ width: w, height: h }); }
  async scrollTop() { await this.js("window.scrollTo(0,0)"); }

  // ---- diagnostics ----
  async jsErrors() {
    let entries = [];
    try { entries = await this.d.manage().logs().get("browser"); } catch { return []; }
    return entries.filter(e => /Uncaught|TypeError|ReferenceError|SyntaxError|is not a function|is not defined|Cannot read/.test(e.message));
  }
  async shot(name) {
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    const png = await this.d.takeScreenshot();
    fs.writeFileSync(path.join(ARTIFACTS, name.replace(/[^\w.-]+/g, "_") + ".png"), png, "base64");
  }
}

let current = null; // the UI of the running spec, so scenario() can screenshot even though `ui` is assigned in before()

// Starts the server and a browser. Call in `before`; `stop()` in `after`.
async function launch({ width = 1280, height = 1000, mobile = false } = {}) {
  const app = await startApp();
  const o = new chrome.Options().addArguments(`--window-size=${width},${height}`, "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--lang=en-IN");
  if (!process.env.HEADED) o.addArguments("--headless=new");
  if (mobile) o.setMobileEmulation({ deviceMetrics: { width, height, pixelRatio: 2 }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" });
  o.setLoggingPrefs({ browser: "SEVERE" });
  const driver = await new Builder().forBrowser("chrome").setChromeOptions(o).build();
  await driver.manage().setTimeouts({ implicit: 0, pageLoad: 30000, script: 30000 });
  const ui = new UI(driver, app);
  current = ui;
  const stop = async () => { try { await driver.quit(); } catch {} await app.stop(); };
  return { ui, app, stop };
}

// Wraps a test body: on failure saves a screenshot and the open dialogs to e2e/artifacts/.
function scenario(ui, fn) {
  return async t => {
    try { await fn(t); }
    catch (e) { try { await (ui || current).shot(t.name); } catch (err) { console.error("could not save screenshot:", err.message); } throw e; }
  };
}

module.exports = { launch, scenario, UI, By, Key, until, sleep, assert };
