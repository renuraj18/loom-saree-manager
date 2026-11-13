// Static checks that need no browser: the page script parses, every element id the code looks up exists,
// tabs and views line up, log types are consistent, and the Windows build ships every server file.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ROOT } = require("./helpers");

const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const js = scripts.join("\n");
const rootModules = fs.readdirSync(ROOT).filter(f => f.endsWith(".js"));

test("every server module passes node --check", () => {
  for (const f of rootModules) execFileSync(process.execPath, ["--check", path.join(ROOT, f)]);
});

test("the page script parses", () => {
  assert.ok(scripts.length >= 1);
  for (const s of scripts) assert.doesNotThrow(() => new Function(s));
});

test("html ids are unique", () => {
  const ids = [...html.matchAll(/\sid="([^"$]+)"/g)].map(m => m[1]);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual([...new Set(dup)], []);
});

test("every $('id') the script looks up exists in the page", () => {
  const present = new Set([...html.matchAll(/\sid="([^"$]+)"/g)].map(m => m[1]));
  const wanted = [...new Set([...js.matchAll(/\$\("([A-Za-z][\w-]*)"\)/g)].map(m => m[1]))];
  // elements that are created at run time (inside rendered markup), not in the static page
  const dynamic = new Set(["logMoreBtn"]);
  const missing = wanted.filter(id => !present.has(id) && !dynamic.has(id));
  assert.deepEqual(missing, [], `ids used by script but missing from the page: ${missing.join(", ")}`);
});

test("every tab links to a view, and every view is routed", () => {
  const tabs = [...html.matchAll(/<a class="tab"[^>]*href="#([a-z]+)"/g)].map(m => m[1]);
  const views = JSON.parse(js.match(/const views=(\[[^\]]*\])/)[1]);
  const sections = [...html.matchAll(/<(?:section|div) id="view-([a-z]+)"/g)].map(m => m[1]);
  for (const t of tabs) assert.ok(views.includes(t), `tab #${t} is not in views[]`);
  for (const v of views) assert.ok(sections.includes(v), `views[] has ${v} but there is no #view-${v}`);
  for (const s of sections) assert.ok(views.includes(s), `#view-${s} is not in views[]`);
  // every view except settings has a tab
  for (const v of views.filter(v => v !== "settings")) assert.ok(tabs.includes(v), `view ${v} has no tab`);
});

test("module-gated tabs and views agree", () => {
  const map = js.match(/const VIEW_MODULE=\{([^}]*)\}/)[1];
  const gated = Object.fromEntries([...map.matchAll(/(\w+):"(\w+)"/g)].map(m => [m[1], m[2]]));
  for (const [view, mod] of Object.entries(gated)) {
    const tab = html.match(new RegExp(`<a class="tab" href="#${view}"([^>]*)>`));
    assert.ok(tab, `tab for ${view}`);
    assert.match(tab[1], new RegExp(`data-mod="${mod}"`), `tab ${view} should be data-mod="${mod}"`);
  }
});

test("every log type the server writes is known to the Log page and its filter", () => {
  const used = new Set([...server.matchAll(/logEvent\(db, req, "([a-z]+)"/g)].map(m => m[1]));
  // moveType() supplies the type for stock moves
  const fromMoveType = ["stock", "process", "delivery"];
  for (const t of fromMoveType) used.add(t);
  const known = new Set([...js.match(/const LOG_TYPE=\{([^}]*)\}/)[1].matchAll(/(\w+):\[/g)].map(m => m[1]));
  const filter = new Set([...html.matchAll(/<option value="([a-z]+)">[^<]*<\/option>/g)].map(m => m[1]));
  for (const t of used) {
    assert.ok(known.has(t), `log type "${t}" missing from LOG_TYPE`);
    assert.ok(filter.has(t), `log type "${t}" missing from the Log filter`);
  }
});

test("every API route the page calls exists on the server", () => {
  const routes = new Set();
  for (const m of server.matchAll(/app\.(get|post|put|delete)\("(\/api\/[^"]+)"/g)) routes.add(m[2].replace(/:[A-Za-z]+/g, ":p"));
  const called = new Set();
  for (const m of js.matchAll(/api\((?:`|")(\/api\/[^`"?]+)/g)) called.add(m[1].replace(/\$\{[^}]+\}/g, ":p"));
  const admin = fs.readFileSync(path.join(ROOT, "admin.js"), "utf8");
  const adminRoutes = new Set([...admin.matchAll(/router\.(get|post|put|delete)\("(\/[^"]+)"/g)].map(m => "/api/admin" + m[2].replace(/:[A-Za-z]+/g, ":p")));
  const authRoutes = new Set(["/api/auth/login", "/api/auth/me", "/api/auth/password"]);
  const missing = [...called].filter(c => !routes.has(c) && !adminRoutes.has(c) && !authRoutes.has(c)
    && ![...routes, ...adminRoutes].some(r => r.replace(/\/:p$/, "") === c.replace(/\/:p$/, "")));
  assert.deepEqual(missing, [], `page calls routes the server does not have: ${missing.join(", ")}`);
});

test("the Windows build ships every server module", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts", "build-windows.js"), "utf8");
  const list = build.match(/for \(const f of \[([^\]]*)\]/)[1];
  for (const f of rootModules) assert.ok(list.includes(`"${f}"`), `${f} is missing from the Windows build file list`);
});

test("the stock ledger maths is the same on the server and in the page", () => {
  // both define SAREE_M and the spent-warp rule
  assert.match(server, /const SAREE_M = 6\.3;/);
  assert.match(js, /const SAREE_M=6\.3;/);
  assert.match(server, /remainingMeters < SAREE_M - 1e-9/);
  assert.match(js, /remainingMeters<SAREE_M-1e-9/);
});

// The body of a top-level function in the page script (up to the next top-level declaration).
const fnBody = name => { const m = js.match(new RegExp(`\\nfunction ${name}\\(([\\s\\S]*?)(?=\\n(?:function |const |let |async function |// ----))`)); return m ? m[0] : null; };

test("the expenses list builds a plain-text details line and escapes it once on output", () => {
  const body = fnBody("renderExpenses");
  assert.match(body, /esc\(bits\.join\(/);
  for (const field of ["x.vendor", "x.billNo", "x.loomName"]) assert.match(body, new RegExp(`esc\\(${field.replace(".", "\\.")}`), `${field} is escaped`);
});

test("toast() and ask() show text with textContent, so names in messages cannot inject markup", () => {
  assert.match(fnBody("toast"), /textContent=msg/);
  assert.doesNotMatch(fnBody("toast"), /innerHTML/);
  const ask = fnBody("ask");
  assert.match(ask, /askTitle"\)\.textContent=title/);
  assert.match(ask, /askText"\)\.textContent=text/);
});

test("card and table renderers pass record names through esc() before putting them in markup", () => {
  const renderers = ["loomCard", "loomSetup", "renderStaff", "renderDesigns", "renderParties", "renderPay", "renderLoomList", "warpCell"];
  for (const name of renderers) {
    const body = fnBody(name);
    assert.ok(body, `found ${name}()`);
    // strip every escaped interpolation, then no record field that holds user text may remain
    const stripped = body.replace(/`[^`]*`\.toLowerCase\(\)/g, "") // search-filter strings are not markup
      .replace(/textContent\s*=\s*`[^`]*`/g, "") // textContent is not parsed as markup
      .replace(/\$\{esc\([^}]*\)\}/g, "").replace(/esc\([^)]*\)/g, "");
    const raw = stripped.match(/\$\{[^}]*\b(?:name|address|note|vendor|billNo|item|phone|designNo|staffName|loomName|clientName)\b[^}]*\}/g) || [];
    // allow values that are only used inside attribute-safe expressions such as .length or comparisons
    const bad = raw.filter(r => !/\.length|===|!==|\?\s*["'`]/.test(r) || /\.name\}$/.test(r));
    assert.deepEqual(bad, [], `${name}() interpolates user text without esc(): ${bad.join(" | ")}`);
  }
});

// ---- party.html (the party app) ----
const partyHtml = fs.readFileSync(path.join(ROOT, "public", "party.html"), "utf8");
const partyJs = [...partyHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");

test("the party app script parses and every $('id') it uses exists", () => {
  assert.doesNotThrow(() => new Function(partyJs));
  const present = new Set([...partyHtml.matchAll(/\sid="([^"$]+)"/g)].map(m => m[1]));
  // ids of fields built inside dialogs at run time
  const dynamic = /^(ap|rj|sh|lm|ds|jo|rf|pw)[A-Z]/;
  const wanted = [...new Set([...partyJs.matchAll(/\$\("([A-Za-z][\w-]*)"\)/g)].map(m => m[1]))];
  const missing = wanted.filter(id => !present.has(id) && !dynamic.test(id));
  assert.deepEqual(missing, [], `party.html uses missing ids: ${missing.join(", ")}`);
});

test("every API route the party app calls exists", () => {
  const party = fs.readFileSync(path.join(ROOT, "party.js"), "utf8");
  const routes = new Set([...party.matchAll(/router\.(get|post|put|delete)\("(\/[^"]+)"/g)].map(m => "/api/party" + m[2].replace(/:[A-Za-z]+/g, ":p")));
  ["/api/auth/me", "/api/auth/password"].forEach(r => routes.add(r));
  const called = [...new Set([...partyJs.matchAll(/api\((?:`|")(\/api\/[^`"?]+)/g)].map(m => m[1].replace(/\$\{[^}]+\}/g, ":p")))];
  const missing = called.filter(c => !routes.has(c));
  assert.deepEqual(missing, [], `party.html calls missing routes: ${missing.join(", ")}`);
});

test("party log types are known to the Log page", () => {
  const party = fs.readFileSync(path.join(ROOT, "party.js"), "utf8");
  const used = new Set([...party.matchAll(/logEvent\(db, req, "([a-z]+)"/g)].map(m => m[1]));
  const known = new Set([...js.match(/const LOG_TYPE=\{([^}]*)\}/)[1].matchAll(/(\w+):\[/g)].map(m => m[1]));
  for (const t of used) assert.ok(known.has(t), `log type "${t}" missing from LOG_TYPE`);
});

// ---- shared styles (public/css) and icons ----
const cssDir = path.join(ROOT, "public", "css");
const cssFiles = fs.readdirSync(cssDir).filter(f => f.endsWith(".css"));
const css = Object.fromEntries(cssFiles.map(f => [f, fs.readFileSync(path.join(cssDir, f), "utf8")]));

test("both pages load tokens, components and their own stylesheet, with no inline <style>", () => {
  for (const [page, own] of [[html, "app.css"], [partyHtml, "party.css"]]) {
    const links = [...page.matchAll(/<link rel="stylesheet" href="css\/([\w-]+\.css)">/g)].map(m => m[1]);
    assert.deepEqual(links, ["tokens.css", "components.css", own]);
    assert.ok(!/<style[\s>]/.test(page.split("<script>")[0]), "styles belong in public/css");
  }
});

test("every CSS variable used is defined", () => {
  const defined = new Set();
  for (const text of Object.values(css)) for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
  const pages = { "index.html": html, "party.html": partyHtml, ...css };
  const missing = [];
  for (const [file, text] of Object.entries(pages)) {
    for (const m of text.matchAll(/var\((--[\w-]+)(,)?/g)) if (!defined.has(m[1]) && !m[2]) missing.push(`${file}: ${m[1]}`);
  }
  // Per-element variables set in rules (e.g. --c1 on .col) count as defined above; inline style="--x:…" ones too.
  for (const m of (html + partyHtml).matchAll(/--([\w-]+):/g)) defined.add("--" + m[1]);
  assert.deepEqual([...new Set(missing.filter(x => !defined.has(x.split(": ")[1])))], []);
});

test("the CSS uses only the two breakpoints (600px phones, 1000px desktop)", () => {
  const bad = [];
  for (const [f, text] of Object.entries(css)) for (const m of text.matchAll(/@media\(([^)]*)\)/g)) {
    if (!/^(max-width:(600|999)px|min-width:1000px)$/.test(m[1])) bad.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(bad, []);
});

test("every icon the pages use exists in img/icons.svg", () => {
  const sprite = fs.readFileSync(path.join(ROOT, "public", "img", "icons.svg"), "utf8");
  const have = new Set([...sprite.matchAll(/<symbol id="([\w-]+)"/g)].map(m => m[1]));
  const used = [...new Set([...(html + partyHtml).matchAll(/icons\.svg#([\w-]+)/g)].map(m => m[1]))];
  assert.deepEqual(used.filter(id => !have.has(id)), []);
});
