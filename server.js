const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const { DATA_DIR, backupConfig, writeJsonAtomic } = require("./paths");
const { backupNow, safeArchiveLogs } = require("./backup");
const store = require("./store");
const { requireAuth, requireAdmin, factoryScope, authRouter } = require("./auth");

// Larger than the default 100kb so a design image (resized in the browser) fits in one request.
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
// Served locally (not from a CDN) so dashboard image export also works on an offline LAN.
app.use("/vendor/html2canvas", express.static(path.join(__dirname, "node_modules", "html2canvas", "dist")));

// Each factory has its own data file (store.factoryFile). Data routes get the factory id from
// factoryScope (X-Factory header), so every read/write below is limited to one factory.
function readDb(factoryId) {
  const file = store.factoryFile(factoryId);
  const db = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : store.emptyFactoryData();
  const migrated = migrateDb(db);
  if (settleSpentWarps(db) || migrated) writeDb(factoryId, db);
  // Stock + Wages factories have no Process step: see stockFor(). Not enumerable, so it is never saved to the file.
  const f = store.readAccounts().factories.find(x => x.id === factoryId);
  Object.defineProperty(db, "direct", { value: noProcess(f), enumerable: false, configurable: true });
  return db;
}
// Atomic (temp file + rename), so a crash or power cut mid-write never leaves a half-written file.
function writeDb(factoryId, db) {
  writeJsonAtomic(store.factoryFile(factoryId), db);
}

// One saree length. A warp with less than this left cannot produce another saree
// (or another set of 3 on a triple-width loom), so it counts as used up.
const SAREE_M = 6.3;
function isSpent(warp) {
  return warp.remainingMeters < SAREE_M - 1e-9;
}
// Completes every unfinished warp that is spent and frees its loom. The leftover
// meters stay in remainingMeters as a record of the offcut. Returns true if anything changed.
// Brings older data files up to the current shape. Returns true if anything changed.
function migrateDb(db) {
  let changed = false;
  for (const key of ["clients", "stockMoves", "staff", "designs", "wagePayouts", "wageDeductions", "wageShifts", "partyPayments", "bobbins", "expenses"]) {
    if (!Array.isArray(db[key])) { db[key] = []; changed = true; }
  }
  if (!Array.isArray(db.activity)) { db.activity = seedActivity(db); db.activityVersion = 2; changed = true; }
  // Log v2: a loom delivery is now called a dispatch, and stock sent to a party a delivery.
  if ((db.activityVersion || 1) < 2) {
    for (const a of db.activity) {
      if (a.type === "delivery" && / delivered from /.test(a.text)) { a.type = "dispatch"; a.text = a.text.replace(" delivered from ", " dispatched from "); }
      else if (a.type === "stock" && / dispatched to /.test(a.text)) { a.type = "delivery"; a.text = a.text.replace(" dispatched to ", " delivered to "); }
    }
    db.activityVersion = 2;
    changed = true;
  }
  // Looms that already had a bobbin before the "needs bobbin" setting existed need one.
  for (const l of db.looms) if (l.needsBobbin === undefined && l.bobbinId) { l.needsBobbin = true; changed = true; }
  // Older deliveries only recorded the warp name; stock is tracked by warp id.
  for (const d of db.deliveries) {
    if (d.warpId) continue;
    const warp = db.warps.find(w => w.name === d.warpName);
    if (warp) { d.warpId = warp.id; changed = true; }
  }
  // Stock v2 added a Folding stage between process and stock. Moves to stock made before that
  // came straight from process, so give each one a matching folding move to keep counts right.
  if ((db.stockVersion || 1) < 2) {
    const legacy = db.stockMoves.filter(m => m.to === "stock");
    for (const m of legacy) db.stockMoves.push({ ...m, id: `${m.id}-F`, to: "folding", migrated: true });
    db.stockVersion = 2;
    changed = true;
  }
  // Stock v3 made every move name its source bucket and added a Sent stage (loom -> godown)
  // before Delivered. Sarees delivered before that were already at the godown, so receive them.
  if (db.stockVersion < 3) {
    const legacyFrom = { process: "delivered", folding: "process", stock: "folding", dispatched: "stock" };
    for (const m of db.stockMoves) if (!m.from && !m.type) m.from = legacyFrom[m.to];
    const byWarp = {};
    for (const d of db.deliveries) if (d.warpId) byWarp[d.warpId] = (byWarp[d.warpId] || 0) + d.sarees;
    for (const [warpId, qty] of Object.entries(byWarp)) {
      const warp = db.warps.find(w => w.id === warpId);
      db.stockMoves.push({ id: `MOV-RCV-${warpId}`, warpId, warpName: warp ? warp.name : "", from: "sent", to: "delivered", qty, createdAt: new Date().toISOString(), migrated: true });
    }
    db.stockVersion = 3;
    changed = true;
  }
  return changed;
}
const isClosed = warp => warp.status === "Completed" || warp.status === "Discarded";
// Bobbins follow the same rule; a spent bobbin just leaves its loom (the warp keeps running).
function settleSpentWarps(db) {
  let changed = false;
  for (const kind of ["warps", "bobbins"]) {
    for (const item of db[kind] || []) {
      if (isClosed(item) || !isSpent(item)) continue;
      const loom = db.looms.find(l => l.id === item.assignedLoomId);
      // The loom stops (see loomState) until a new one is put on; warpEnded/bobbinEnded say why.
      if (loom && kind === "warps") { loom.warpId = null; loom.status = "Warp Completed"; loom.warpEnded = { name: item.name, at: new Date().toISOString() }; }
      if (loom && kind === "bobbins") { loom.bobbinId = null; loom.bobbinEnded = { name: item.name, at: new Date().toISOString() }; }
      item.assignedLoomId = null;
      item.status = "Completed";
      item.completedAt = new Date().toISOString();
      changed = true;
    }
  }
  return changed;
}
// Activity log: every change to a factory's data adds one entry, newest first.
const sarees = n => `${n} saree${n === 1 ? "" : "s"}`;
const actor = req => req.user.name || req.user.username;
function logEvent(db, req, type, text) {
  db.activity.unshift({ id: id("LOG"), type, text, by: actor(req), at: new Date().toISOString() });
}
// Builds a log from existing records for data saved before the activity log existed.
function seedActivity(db) {
  const width = w => w === "triple" ? "triple width" : "single width";
  const out = [];
  const add = (type, text, at, by = "") => at && out.push({ id: `LOG-SEED-${out.length}`, type, text, by, at, seeded: true });
  for (const w of db.warps) add("warp", `Warp ${w.name} added · ${width(w.widthType)} · ${w.originalMeters} m · ${w.bodyColor} / ${w.borderColor}`, w.createdAt);
  for (const l of db.looms) add("loom", `Loom ${l.name} added · ${width(l.widthType)}`, l.createdAt);
  for (const c of db.clients || []) add("party", `Party ${c.name} added`, c.createdAt);
  for (const d of db.deliveries) {
    const loom = d.loomName || db.looms.find(l => l.id === d.loomId)?.name || "a loom";
    const meters = d.metersReduced != null ? ` · ${d.metersReduced} m used${d.remainingMeters != null ? `, ${d.remainingMeters} m left` : ""}` : "";
    add("dispatch", `${sarees(d.sarees)} dispatched from ${loom}${d.warpName ? ` (${d.warpName})` : ""}${meters}${d.lrNumber ? ` · LR ${d.lrNumber}` : ""}`, d.createdAt);
  }
  for (const m of db.stockMoves || []) if (!m.migrated) add(moveType(m), moveText(m), m.createdAt, m.by);
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
// Log type of a stock move: per-warp steps are "process", stock -> party is "delivery".
function moveType(m) {
  if (m.type !== "adjust" && ["sent", "delivered", "process", "folding"].includes(m.from)) return "process";
  return m.from === "stock" && m.to === "dispatched" ? "delivery" : "stock";
}
function moveText(m) {
  const of = m.warpName ? ` of ${m.warpName}` : "";
  const why = m.note ? ` · ${m.note}` : "";
  if (m.type === "adjust") return `${STOCK_NAME[m.to] || m.to}${of} adjusted ${m.qty > 0 ? "+" : ""}${m.qty}${m.count != null ? ` (now ${m.count})` : ""}${why}`;
  const text = {
    "sent>delivered": `${sarees(m.qty)}${of} received at the godown`,
    "delivered>process": `${sarees(m.qty)}${of} sent to process`,
    "delivered>mai": `${sarees(m.qty)}${of} found with greese (mai) at checking`,
    "delivered>damage": `${sarees(m.qty)}${of} found damaged at checking`,
    "process>folding": `${sarees(m.qty)}${of} sent to folding`,
    "folding>stock": `${sarees(m.qty)}${of} added to stock`,
    "folding>mai": `${sarees(m.qty)}${of} added to greese (mai)`,
    "folding>lot": `${sarees(m.qty)}${of} added to lot`,
    "folding>damage": `${sarees(m.qty)}${of} added to damage`,
    "mai>cleaning": `${sarees(m.qty)} sent for cleaning`,
    "cleaning>stock": `${sarees(m.qty)} back from cleaning${m.batchSentAt ? ` (batch sent ${String(m.batchSentAt).slice(0, 10)}${m.batchNote ? `, ${m.batchNote}` : ""})` : ""}, added to stock`,
    "stock>damage": `${sarees(m.qty)} moved from stock to damage (damage return)`,
    "stock>dispatched": `${sarees(m.qty)}${of} delivered to ${m.clientName}${m.lrNumber ? ` · LR ${m.lrNumber}` : ""}${m.designNo ? ` · ${m.designNo} ${m.qty} × ₹${m.rate} = ₹${m.amount}` : ""}`,
    "dispatched>stock": `${sarees(m.qty)} returned by ${m.clientName}, added to stock${m.designNo ? ` · ${m.designNo} ${m.qty} × ₹${m.rate} = ₹${m.amount} credited` : ""}`,
    "damage>returned": `${sarees(m.qty)} damaged returned to loom owner${m.ownerName ? ` ${m.ownerName}` : ""}`
  }[`${m.from}>${m.to}`];
  return (text || `${sarees(m.qty)} moved ${m.from} → ${m.to}`) + why;
}
const STOCK_NAME = { delivered: "Godown", folding: "Folding", process: "Process", stock: "Stock", mai: "Greese (mai)", lot: "Lot", damage: "Damage" };
function id(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}
function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}
function isoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : null;
}
function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Warps and bobbins share one board lifecycle (Ordered -> Ready -> In Use -> Completed, or Discarded).
// A loom holds at most one warp (loom.warpId) and, optionally, one bobbin (loom.bobbinId).
const BOARD = {
  warps: { slot: "warpId", noun: "warp", Noun: "Warp" },
  bobbins: { slot: "bobbinId", noun: "bobbin", Noun: "Bobbin" }
};
// A loom runs only when it is not stopped by hand, has a warp and, if it needs one (loom.needsBobbin),
// a bobbin. Anything else is "stopped" with a reason. Mirrored on the page by loomState().
function loomState(db, loom) {
  if (loom.stoppedAt) return { running: false, manual: true, reason: loom.stopReason || "Stopped by hand" };
  if (!loom.warpId) return { running: false, reason: loom.warpEnded ? `Warp ${loom.warpEnded.name} finished` : "No warp" };
  if (loom.needsBobbin && !loom.bobbinId) return { running: false, reason: loom.bobbinEnded ? `Bobbin ${loom.bobbinEnded.name} finished` : "No bobbin" };
  return { running: true, reason: "" };
}
// Returns [httpStatus, message] if the warp/bobbin cannot be put on the loom, else null.
function assignError(loom, warp, kind = "warps") {
  const { slot, noun, Noun } = BOARD[kind];
  if (loom.stoppedAt) return [409, `This loom is stopped. Resume it before assigning a ${noun}.`];
  if (kind === "bobbins" && !loom.needsBobbin) return [400, `${loom.name} runs on warp only. Edit the loom to use a bobbin.`];
  if (warp.status === "Discarded") return [409, `This ${noun} has been discarded.`];
  if (loom[slot]) return [409, `This loom already has a ${noun} assigned. Finish or remove its current ${noun} first.`];
  if (warp.widthType !== loom.widthType) return [400, `${Noun} width type must match the loom width type.`];
  if (warp.assignedLoomId) return [409, `This ${noun} is already assigned to another active loom.`];
  if (warp.status === "Completed" || isSpent(warp)) return [400, `This ${noun} is completed (less than ${SAREE_M} m left).`];
  if (warp.status === "Ordered") return [400, `This ${noun} is still on order. Mark it ready before assigning it to a loom.`];
  return null;
}
function assignWarp(loom, warp, kind = "warps") {
  loom[BOARD[kind].slot] = warp.id;
  delete loom[kind === "warps" ? "warpEnded" : "bobbinEnded"];
  if (kind === "warps") loom.status = "Running";
  warp.assignedLoomId = loom.id;
  warp.status = "In Use";
  warp.startedAt = new Date().toISOString();
}

app.get("/api/health", (_req, res) => res.json({ status: "ok", app: "My Thari" }));
app.use("/api/auth", authRouter());
app.use("/api/admin", requireAuth, requireAdmin, require("./admin")({ flushToStock: id => flushToStock(id) }));
// Everything below works on one factory's data and needs a signed-in user with access to it.
app.use(["/api/data", "/api/warps", "/api/bobbins", "/api/looms", "/api/deliveries", "/api/clients", "/api/stock", "/api/order", "/api/staff", "/api/designs", "/api/wages", "/api/expenses"], requireAuth, factoryScope);
// Each factory turns the Stock module (process, stock, parties) and the Wages module (staff, designs,
// wages) on or off in Settings (factory.modules, missing = on). Production (warps, looms, dispatch) is always on.
// Stock + Wages factories skip the Process step unless "Include Process" is ticked (modules.process).
const noProcess = f => !!f && modulesOf(f).stock && modulesOf(f).wages && f?.modules?.process !== true;
const modulesOf = f => ({ stock: f?.modules?.stock !== false, wages: f?.modules?.wages !== false });
const needModule = (name, label) => (req, res, next) => modulesOf(req.factory)[name] ? next()
  : res.status(403).json({ error: `${label} is turned off for this factory. An admin can turn it on in Settings.` });
app.use(["/api/stock", "/api/clients"], needModule("stock", "Stock"));
app.use(["/api/staff", "/api/designs", "/api/wages", "/api/looms/:id/setup"], needModule("wages", "Wages"));
// Stock-only factories have no looms to cost, so Expenses is off for them too (it follows the Wages module).
app.use("/api/expenses", needModule("wages", "Expenses"));
// Design images and staff photos are left out (only hasImage); the page loads each one from
// /api/designs/:id/image or /api/staff/:id/image.
const noImage = ({ image, ...rest }) => ({ ...rest, hasImage: !!image });
app.get("/api/data", (req, res) => {
  const db = readDb(req.factoryId);
  res.json({ ...db, designs: db.designs.map(noImage), staff: db.staff.map(noImage) });
});

app.post("/api/warps", (req, res) => {
  const body = req.body || {};
  const name = cleanText(body.name);
  const widthType = body.widthType;
  const meters = positiveNumber(body.meters);
  const bodyColor = cleanText(body.bodyColor);
  const borderColor = cleanText(body.borderColor);
  const orderDate = body.orderDate ? isoDate(body.orderDate) : new Date().toISOString().slice(0, 10);
  const hex = v => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null;
  if (!name || !["single", "triple"].includes(widthType) || !meters || !bodyColor || !borderColor) {
    return res.status(400).json({ error: "Enter warp name/ID, width type, meters, body colour, and border colour." });
  }
  if (!orderDate) return res.status(400).json({ error: "Enter a valid warp order date." });
  if (meters < SAREE_M) return res.status(400).json({ error: `A warp must be at least ${SAREE_M} m (one saree length).` });
  const db = readDb(req.factoryId);
  if (db.warps.some(w => w.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: "A warp with this ID/name already exists." });
  }
  const warp = {
    id: id("WARP"), name, widthType, originalMeters: meters, remainingMeters: meters,
    bodyColor, borderColor, bodyHex: hex(body.bodyHex), borderHex: hex(body.borderHex), orderDate, status: "Ordered", assignedLoomId: null,
    createdAt: new Date().toISOString()
  };
  db.warps.unshift(warp);
  logEvent(db, req, "warp", `Warp ${name} added · ${widthType} width · ${meters} m · ${bodyColor} / ${borderColor}`);
  writeDb(req.factoryId, db);
  res.status(201).json(warp);
});

// A bobbin (weft) is measured like a warp: meters, or sarees at 6.3 m each (3 per 6.3 m on triple width).
app.post("/api/bobbins", (req, res) => {
  const body = req.body || {};
  const name = cleanText(body.name), widthType = body.widthType, meters = positiveNumber(body.meters), color = cleanText(body.color);
  const orderDate = body.orderDate ? isoDate(body.orderDate) : new Date().toISOString().slice(0, 10);
  const colorHex = typeof body.colorHex === "string" && /^#[0-9a-f]{6}$/i.test(body.colorHex) ? body.colorHex.toLowerCase() : null;
  if (!name || !["single", "triple"].includes(widthType) || !meters || !color) {
    return res.status(400).json({ error: "Enter bobbin name/ID, width type, meters and colour." });
  }
  if (!orderDate) return res.status(400).json({ error: "Enter a valid bobbin order date." });
  if (meters < SAREE_M) return res.status(400).json({ error: `A bobbin must be at least ${SAREE_M} m (one saree length).` });
  const db = readDb(req.factoryId);
  if (db.bobbins.some(b => b.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: "A bobbin with this ID/name already exists." });
  const bobbin = { id: id("BOB"), name, widthType, originalMeters: meters, remainingMeters: meters, color, colorHex, orderDate,
    status: "Ordered", assignedLoomId: null, createdAt: new Date().toISOString() };
  db.bobbins.unshift(bobbin);
  logEvent(db, req, "bobbin", `Bobbin ${name} added · ${widthType} width · ${meters} m · ${color}`);
  writeDb(req.factoryId, db);
  res.status(201).json(bobbin);
});

app.post("/api/looms", (req, res) => {
  const body = req.body || {};
  const name = cleanText(body.name);
  const widthType = body.widthType;
  const plan = cleanText(body.plan);
  const warpId = cleanText(body.warpId);
  const plannedMeters = body.plannedMeters === "" || body.plannedMeters == null ? null : positiveNumber(body.plannedMeters);
  const bodyColor = cleanText(body.bodyColor);
  const borderColor = cleanText(body.borderColor);
  // Only number and width are required; plan/colours are optional extras kept for older records.
  if (!name || !["single", "triple"].includes(widthType)) {
    return res.status(400).json({ error: "Enter loom number and width type." });
  }
  if (body.plannedMeters != null && body.plannedMeters !== "" && !plannedMeters) {
    return res.status(400).json({ error: "Planned meters must be a positive number." });
  }
  const db = readDb(req.factoryId);
  if (db.looms.some(l => l.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: "A loom with this number/name already exists." });
  }
  let warp = null;
  if (warpId) {
    warp = db.warps.find(w => w.id === warpId);
    if (!warp) return res.status(404).json({ error: "Selected warp was not found." });
    if (warp.widthType !== widthType) return res.status(400).json({ error: "Warp width type must match the loom width type." });
    if (warp.assignedLoomId) return res.status(409).json({ error: "This warp is already assigned to another active loom." });
    if (warp.status === "Completed" || isSpent(warp)) return res.status(400).json({ error: `This warp is completed (less than ${SAREE_M} m left).` });
    if (warp.status === "Ordered") return res.status(400).json({ error: "This warp is still on order. Mark it ready before assigning it to a loom." });
  }
  const loom = {
    id: id("LOOM"), name, widthType, plan, bodyColor, borderColor,
    plannedMeters, wovenMeters: 0, warpId: warp ? warp.id : null, needsBobbin: body.needsBobbin === true,
    status: warp ? "Running" : "Available", createdAt: new Date().toISOString()
  };
  if (warp) {
    warp.assignedLoomId = loom.id;
    warp.status = "In Use";
    warp.startedAt = loom.createdAt;
  }
  db.looms.unshift(loom);
  logEvent(db, req, "loom", `Loom ${name} added · ${widthType} width · ${loom.needsBobbin ? "warp + bobbin" : "warp only"}${warp ? ` · running ${warp.name}` : ""}`);
  writeDb(req.factoryId, db);
  res.status(201).json(loom);
});

app.post("/api/deliveries", (req, res) => {
  const body = req.body || {};
  const loomId = cleanText(body.loomId);
  const quantity = Number(body.sarees);
  const designId = cleanText(body.designId);
  const note = cleanText(body.note);
  const lrNumber = cleanText(body.lrNumber);
  const db = readDb(req.factoryId);
  const loom = db.looms.find(l => l.id === loomId);
  if (!loom) return res.status(404).json({ error: "Select a valid loom." });
  if (loom.stoppedAt) return res.status(409).json({ error: "This loom is stopped. Resume it before recording a delivery." });
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return res.status(400).json({ error: "Number of sarees must be a positive whole number." });
  }
  if (designId && !loomDesignIds(loom).includes(designId)) return res.status(400).json({ error: "That design is not set on this loom." });
  if (!loom.warpId) return res.status(400).json({ error: "This loom has no warp assigned. Assign a warp before marking delivery." });
  const warp = db.warps.find(w => w.id === loom.warpId);
  if (!warp) return res.status(400).json({ error: "Assigned warp record was not found." });

  // Standard saree length is 6.3 m. A triple-width loom produces three saree widths
  // together over the same woven length, so total sarees must be in groups of three.
  if (loom.widthType === "triple" && quantity % 3 !== 0) {
    return res.status(400).json({ error: "For a triple-width loom, enter the total sarees in multiples of 3 (one from each width)." });
  }
  const metersToReduce = quantity * SAREE_M / (loom.widthType === "triple" ? 3 : 1);
  if (metersToReduce > warp.remainingMeters + 1e-9) {
    return res.status(400).json({ error: `Not enough warp meters. Available: ${warp.remainingMeters.toFixed(2)} m; required: ${metersToReduce.toFixed(2)} m.` });
  }
  const bobbin = loom.bobbinId ? db.bobbins.find(b => b.id === loom.bobbinId) : null;
  if (loom.needsBobbin && !bobbin) return res.status(409).json({ error: `${loom.name} needs a bobbin to run. Put a bobbin on it first.` });
  if (bobbin && metersToReduce > bobbin.remainingMeters + 1e-9) {
    return res.status(400).json({ error: `Not enough bobbin on ${loom.name}. ${bobbin.name} has ${bobbin.remainingMeters.toFixed(2)} m; required: ${metersToReduce.toFixed(2)} m.` });
  }
  if (bobbin) bobbin.remainingMeters = Math.max(0, Number((bobbin.remainingMeters - metersToReduce).toFixed(2)));
  warp.remainingMeters = Math.max(0, Number((warp.remainingMeters - metersToReduce).toFixed(2)));
  loom.wovenMeters = Number((loom.wovenMeters + metersToReduce).toFixed(2));
  settleSpentWarps(db);
  const delivery = {
    id: id("DEL"), loomId: loom.id, loomName: loom.name, warpId: warp.id, warpName: warp.name,
    widthType: loom.widthType, sarees: quantity, metersReduced: Number(metersToReduce.toFixed(2)),
    remainingMeters: warp.remainingMeters, note, lrNumber, createdAt: new Date().toISOString(),
    ...(bobbin ? { bobbinId: bobbin.id, bobbinName: bobbin.name, bobbinRemaining: bobbin.remainingMeters } : {}),
    ...(modulesOf(req.factory).wages ? dispatchWage(req.factory, db, loom, quantity, designId || loom.designId) : {})
  };
  db.deliveries.unshift(delivery);
  if (delivery.designId && loom.designId !== delivery.designId) loom.designId = delivery.designId; // the loom is now weaving this design
  const wageText = delivery.wage != null ? ` · wage ${money(delivery.wage)} to ${delivery.staffName} (${delivery.designNo})` : "";
  logEvent(db, req, "dispatch", `${sarees(quantity)} dispatched from ${loom.name} (${warp.name}) · ${delivery.metersReduced} m used, ${warp.remainingMeters} m left${lrNumber ? ` · LR ${lrNumber}` : ""}${bobbin ? ` · bobbin ${bobbin.name} ${bobbin.remainingMeters} m left` : ""}${wageText}${warp.status === "Completed" ? ` · ${warp.name} completed, ${loom.name} free` : ""}${bobbin && bobbin.status === "Completed" ? ` · bobbin ${bobbin.name} completed` : ""}${loomState(db, loom).running ? "" : ` · ${loom.name} stopped: ${loomState(db, loom).reason}`}`);
  writeDb(req.factoryId, db);
  res.status(201).json({ delivery, loom, warp, bobbin });
});

// Corrects the sarees left on a warp that is on a loom (woven = the rest of the original length).
// The offcut under one saree length is kept. { leftSarees }
app.put("/api/warps/:id/balance", (req, res) => {
  const db = readDb(req.factoryId);
  const warp = db.warps.find(w => w.id === req.params.id);
  if (!warp) return res.status(404).json({ error: "Warp not found." });
  if (!warp.assignedLoomId || warp.status !== "In Use") return res.status(409).json({ error: "Only a warp running on a loom can be corrected." });
  const left = Number(req.body?.leftSarees), per = warp.widthType === "triple" ? 3 : 1;
  if (!Number.isInteger(left) || left < 0) return res.status(400).json({ error: "Enter the sarees left as a whole number (0 or more)." });
  if (left % per) return res.status(400).json({ error: "For a triple-width warp, enter the sarees in multiples of 3." });
  const offcut = round2(warp.remainingMeters - Math.floor((warp.remainingMeters + 1e-9) / SAREE_M) * SAREE_M);
  const next = round2(left / per * SAREE_M + Math.max(0, offcut));
  if (next > warp.originalMeters + 1e-9) return res.status(400).json({ error: `${warp.name} was only ${warp.originalMeters} m long. At most ${Math.floor(warp.originalMeters / SAREE_M) * per} sarees can be left.` });
  if (Math.abs(next - warp.remainingMeters) < 1e-9) return res.json({ warp, changed: 0 });
  const loom = db.looms.find(l => l.id === warp.assignedLoomId), was = warp.remainingMeters;
  if (loom) loom.wovenMeters = Math.max(0, round2(loom.wovenMeters + was - next));
  warp.remainingMeters = Math.max(0, next);
  const q = m => Math.floor((m + 1e-9) / SAREE_M) * per;
  logEvent(db, req, "warp", `${warp.name} balance corrected on ${loom ? loom.name : "loom"} · ${q(was)} → ${q(next)} sarees left (${was} → ${next} m)${warp.remainingMeters < SAREE_M - 1e-9 ? ` · ${warp.name} completed` : ""}`);
  settleSpentWarps(db);
  writeDb(req.factoryId, db);
  res.json({ warp, changed: 1 });
});

// Corrects a dispatch: sarees (warp, bobbin, loom and unpaid wage follow) and/or LR number and note.
//   { sarees?, lrNumber?, note? }
app.put("/api/deliveries/:id", (req, res) => {
  const body = req.body || {};
  const db = readDb(req.factoryId);
  const d = db.deliveries.find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: "Dispatch not found." });
  const n = body.sarees == null || body.sarees === "" ? d.sarees : Number(body.sarees);
  if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ error: "Number of sarees must be a positive whole number." });
  const triple = d.widthType === "triple";
  if (triple && n % 3 !== 0) return res.status(400).json({ error: "For a triple-width loom, enter the total sarees in multiples of 3." });
  const changes = [];
  if (n !== d.sarees) {
    if (d.payoutId) return res.status(409).json({ error: "The wages for this dispatch are already settled, so its sarees can't be changed." });
    const warp = db.warps.find(w => w.id === d.warpId);
    if (!warp || !["In Use", "Ready"].includes(warp.status)) return res.status(409).json({ error: "This dispatch's warp is completed or removed, so its sarees can't be changed." });
    const bobbin = d.bobbinId ? db.bobbins.find(b => b.id === d.bobbinId) : null;
    if (d.bobbinId && (!bobbin || !["In Use", "Ready"].includes(bobbin.status))) return res.status(409).json({ error: "This dispatch's bobbin is completed or removed, so its sarees can't be changed." });
    const delta = (n - d.sarees) * SAREE_M / (triple ? 3 : 1);
    if (delta > warp.remainingMeters + 1e-9) return res.status(400).json({ error: `Not enough warp meters on ${warp.name}. Available: ${warp.remainingMeters.toFixed(2)} m; extra needed: ${delta.toFixed(2)} m.` });
    if (bobbin && delta > bobbin.remainingMeters + 1e-9) return res.status(400).json({ error: `Not enough bobbin ${bobbin.name}. Available: ${bobbin.remainingMeters.toFixed(2)} m; extra needed: ${delta.toFixed(2)} m.` });
    const moved = { ...d, sarees: n };
    const left = stockFor({ deliveries: db.deliveries.map(x => x === d ? moved : x), stockMoves: db.stockMoves }, d.warpId).sent;
    if (left < 0) return res.status(409).json({ error: `Sarees from this dispatch have already moved on in Process. It can't go below ${sarees(n - left)}; correct the Process counts first to go lower.` });
    const fix = v => Math.max(0, Number(v.toFixed(2)));
    warp.remainingMeters = fix(warp.remainingMeters - delta);
    const loom = db.looms.find(l => l.id === d.loomId);
    if (loom) loom.wovenMeters = fix(loom.wovenMeters + delta);
    if (bobbin) { bobbin.remainingMeters = fix(bobbin.remainingMeters - delta); d.bobbinRemaining = fix(d.bobbinRemaining - delta); }
    d.remainingMeters = fix(d.remainingMeters - delta);
    d.metersReduced = fix(d.metersReduced + delta);
    changes.push(`${d.sarees} → ${n} sarees`);
    d.sarees = n;
    if (d.wage != null) { delete d.wageSarees; d.wage = round2(n * d.rate); }
    settleSpentWarps(db);
  }
  const lr = body.lrNumber == null ? d.lrNumber : cleanText(body.lrNumber);
  const note = body.note == null ? d.note : cleanText(body.note);
  if ((lr || "") !== (d.lrNumber || "")) { changes.push(`LR ${lr || "removed"}`); d.lrNumber = lr; }
  if ((note || "") !== (d.note || "")) { changes.push("note changed"); d.note = note; }
  if (!changes.length) return res.json({ delivery: d, changed: 0 });
  Object.assign(d, { editedBy: actor(req), editedAt: new Date().toISOString() });
  logEvent(db, req, "dispatch", `Dispatch from ${d.loomName} (${d.warpName}) on ${d.createdAt.slice(0, 10)} edited · ${changes.join(", ")}`);
  writeDb(req.factoryId, db);
  res.json({ delivery: d, changed: changes.length });
});

// Moves a warp or bobbin between board stages: ordered <-> ready <-> running. "Done" is reached
// only through deliveries using it up, so it is never a valid target here.
function moveRoute(kind) {
  const { slot, noun, Noun } = BOARD[kind];
  return (req, res) => {
    const body = req.body || {};
    const db = readDb(req.factoryId);
    const warp = db[kind].find(w => w.id === req.params.id);
    if (!warp) return res.status(404).json({ error: `${Noun} not found.` });
    if (warp.status === "Discarded") return res.status(409).json({ error: `Discarded ${noun}s cannot be moved.` });
    if (warp.status === "Completed" || isSpent(warp)) return res.status(409).json({ error: `Completed ${noun}s cannot be moved.` });
    const date = body.date ? isoDate(body.date) : new Date().toISOString().slice(0, 10);
    if (!date) return res.status(400).json({ error: "Enter a valid date." });
    const from = warp.assignedLoomId ? "running" : warp.status === "Ordered" ? "ordered" : "ready";
    const to = body.to;
    if (from === to) return res.json({ [noun]: warp });
    const offLoom = db.looms.find(l => l.id === warp.assignedLoomId);

    if (to === "ordered") {
      if (from !== "ready") return res.status(409).json({ error: `Take the ${noun} off its loom before moving it back to ordered.` });
      if (warp.remainingMeters < warp.originalMeters) return res.status(409).json({ error: `This ${noun} has already been woven and cannot go back to ordered.` });
      warp.status = "Ordered";
      delete warp.readyDate;
    } else if (to === "ready") {
      if (from === "running") {
        if (offLoom) { offLoom[slot] = null; if (kind === "warps") offLoom.status = "Available"; }
        warp.assignedLoomId = null;
        delete warp.startedAt;
      } else {
        warp.readyDate = date;
      }
      warp.status = "Ready";
    } else if (to === "running") {
      const loom = db.looms.find(l => l.id === cleanText(body.loomId));
      if (!loom) return res.status(404).json({ error: `Select a loom to run this ${noun} on.` });
      if (from === "ordered") { warp.status = "Ready"; warp.readyDate = date; }
      const err = assignError(loom, warp, kind);
      if (err) return res.status(err[0]).json({ error: err[1] });
      assignWarp(loom, warp, kind);
    } else {
      return res.status(400).json({ error: `${Noun}s move to Done automatically when all their meters are used.` });
    }
    const loomNow = db.looms.find(l => l.id === warp.assignedLoomId);
    logEvent(db, req, noun, to === "ordered" ? `${Noun} ${warp.name} moved back to ordered`
      : to === "running" ? `${Noun} ${warp.name} started on ${loomNow ? loomNow.name : "a loom"}`
      : from === "running" ? `${Noun} ${warp.name} taken off ${offLoom ? offLoom.name : "its loom"}, back to ready` : `${Noun} ${warp.name} marked ready`);
    writeDb(req.factoryId, db);
    res.json({ [noun]: warp });
  };
}
app.post("/api/warps/:id/move", moveRoute("warps"));
app.post("/api/bobbins/:id/move", moveRoute("bobbins"));

app.post("/api/looms/:id/assign-warp", (req, res) => {
  const db = readDb(req.factoryId);
  const loom = db.looms.find(l => l.id === req.params.id);
  const warp = db.warps.find(w => w.id === cleanText(req.body?.warpId));
  if (!loom) return res.status(404).json({ error: "Loom not found." });
  if (!warp) return res.status(404).json({ error: "Warp not found." });
  const err = assignError(loom, warp);
  if (err) return res.status(err[0]).json({ error: err[1] });
  assignWarp(loom, warp);
  logEvent(db, req, "warp", `Warp ${warp.name} started on ${loom.name}`);
  writeDb(req.factoryId, db);
  res.json({ loom, warp });
});

function discardRoute(kind) {
  const { noun, Noun } = BOARD[kind];
  return (req, res) => {
    const db = readDb(req.factoryId);
    const warp = db[kind].find(w => w.id === req.params.id);
    if (!warp) return res.status(404).json({ error: `${Noun} not found.` });
    if (isClosed(warp)) return res.status(409).json({ error: `This ${noun} is already ${warp.status.toLowerCase()}.` });
    if (warp.assignedLoomId) return res.status(409).json({ error: `This ${noun} is on a loom. Take it off the loom (drag it to Ready) before discarding.` });
    warp.status = "Discarded";
    warp.discardedAt = new Date().toISOString();
    warp.discardReason = cleanText(req.body?.reason);
    logEvent(db, req, noun, `${Noun} ${warp.name} discarded${warp.discardReason ? ` · ${warp.discardReason}` : ""}`);
    writeDb(req.factoryId, db);
    res.json({ [noun]: warp });
  };
}
app.post("/api/warps/:id/discard", requireAdmin, discardRoute("warps"));
app.post("/api/bobbins/:id/discard", requireAdmin, discardRoute("bobbins"));

app.post("/api/looms/:id/stop", (req, res) => {
  const db = readDb(req.factoryId);
  const loom = db.looms.find(l => l.id === req.params.id);
  if (!loom) return res.status(404).json({ error: "Loom not found." });
  if (loom.stoppedAt) return res.status(409).json({ error: "This loom is already stopped." });
  loom.stoppedAt = new Date().toISOString();
  loom.stopReason = cleanText(req.body?.reason);
  logEvent(db, req, "loom", `Loom ${loom.name} stopped${loom.stopReason ? ` · ${loom.stopReason}` : ""}`);
  writeDb(req.factoryId, db);
  res.json(loom);
});

app.post("/api/looms/:id/resume", (req, res) => {
  const db = readDb(req.factoryId);
  const loom = db.looms.find(l => l.id === req.params.id);
  if (!loom) return res.status(404).json({ error: "Loom not found." });
  delete loom.stoppedAt;
  delete loom.stopReason;
  logEvent(db, req, "loom", `Loom ${loom.name} resumed`);
  writeDb(req.factoryId, db);
  res.json(loom);
});

// Edits a loom: number, width (only while nothing is on it) and whether it needs a bobbin
// (can't be turned off while a bobbin is on it).
app.put("/api/looms/:id", (req, res) => {
  const body = req.body || {};
  const db = readDb(req.factoryId);
  const loom = db.looms.find(l => l.id === req.params.id);
  if (!loom) return res.status(404).json({ error: "Loom not found." });
  const name = cleanText(body.name), widthType = body.widthType, needsBobbin = body.needsBobbin === true;
  if (!name || !["single", "triple"].includes(widthType)) return res.status(400).json({ error: "Enter loom number and width type." });
  if (db.looms.some(l => l !== loom && l.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: "A loom with this number/name already exists." });
  if (widthType !== loom.widthType && (loom.warpId || loom.bobbinId)) return res.status(409).json({ error: "Take the warp and bobbin off this loom before changing its width." });
  if (!needsBobbin && loom.bobbinId) return res.status(409).json({ error: "Take the bobbin off this loom before setting it to warp only." });
  const changes = [];
  if (name !== loom.name) changes.push(`renamed ${name}`);
  if (widthType !== loom.widthType) changes.push(`${widthType} width`);
  if (needsBobbin !== !!loom.needsBobbin) changes.push(needsBobbin ? "now needs a bobbin" : "now warp only");
  const old = loom.name;
  Object.assign(loom, { name, widthType, needsBobbin });
  if (changes.length) logEvent(db, req, "loom", `Loom ${old} updated · ${changes.join(", ")}`);
  writeDb(req.factoryId, db);
  res.json(loom);
});

// Removing a loom needs it to be stopped (by hand, or because it has no warp/bobbin). A warp or
// bobbin still on it goes back to Ready. Delivery records keep their loomName snapshot.
app.delete("/api/looms/:id", requireAdmin, (req, res) => {
  const db = readDb(req.factoryId);
  const index = db.looms.findIndex(l => l.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: "Loom not found." });
  const loom = db.looms[index];
  if (loomState(db, loom).running) return res.status(409).json({ error: "Stop the loom before removing it." });
  const warp = db.warps.find(w => w.id === loom.warpId);
  if (warp) {
    warp.assignedLoomId = null;
    warp.status = "Ready";
    delete warp.startedAt;
  }
  const bobbin = db.bobbins.find(b => b.id === loom.bobbinId);
  if (bobbin) {
    bobbin.assignedLoomId = null;
    bobbin.status = "Ready";
    delete bobbin.startedAt;
  }
  db.looms.splice(index, 1);
  logEvent(db, req, "loom", `Loom ${loom.name} removed${warp ? ` · ${warp.name} back to ready` : ""}${bobbin ? ` · bobbin ${bobbin.name} back to ready` : ""}`);
  writeDb(req.factoryId, db);
  res.json({ removed: loom.id, warp: warp || null });
});

app.post("/api/clients", (req, res) => {
  const name = cleanText(req.body?.name);
  const address = cleanText(req.body?.address);
  if (!name) return res.status(400).json({ error: "Enter the party name." });
  const db = readDb(req.factoryId);
  if (db.clients.some(c => c.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: "A party with this name already exists." });
  }
  const client = { id: id("CLI"), name, address, createdAt: new Date().toISOString() };
  db.clients.unshift(client);
  logEvent(db, req, "party", `Party ${name} added${address ? ` · ${address.split("\n")[0]}` : ""}`);
  writeDb(req.factoryId, db);
  res.status(201).json(client);
});

// Per-party selling rates: { designId: ₹ per saree }. Blank / 0 means no rate for that design. Unknown designs are dropped.
function partyRates(db, raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return { rates: out };
  for (const [designId, v] of Object.entries(raw)) {
    if (v === "" || v == null || Number(v) === 0) continue;
    const design = db.designs.find(d => d.id === designId);
    if (!design) continue;
    const rate = rateField(v);
    if (rate == null) return { error: `Enter a rate above 0 for design ${design.number}, or leave it blank.` };
    out[designId] = rate;
  }
  return { rates: out };
}
// Edit a party: name, address and the rate per saree for each design (rates apply to deliveries from then on).
app.put("/api/clients/:id", (req, res) => {
  const db = readDb(req.factoryId);
  const client = db.clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: "Party not found." });
  const name = cleanText(req.body?.name), address = cleanText(req.body?.address);
  if (!name) return res.status(400).json({ error: "Enter the party name." });
  if (db.clients.some(c => c !== client && c.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: "A party with this name already exists." });
  const changes = [];
  if (client.name !== name) changes.push(`renamed ${name}`);
  let rates = client.rates || {};
  if (req.body?.rates !== undefined) {
    const r = partyRates(db, req.body.rates);
    if (r.error) return res.status(400).json({ error: r.error });
    for (const d of db.designs) {
      const was = rates[d.id] ?? null, now = r.rates[d.id] ?? null;
      if (was !== now) changes.push(`${d.number} ${was == null ? "—" : money(was)} → ${now == null ? "—" : money(now)}`);
    }
    rates = r.rates;
  }
  Object.assign(client, { name, address, rates });
  logEvent(db, req, "party", `Party ${name} updated${changes.length ? ` · rates/changes: ${changes.join(", ")}` : ""}`);
  writeDb(req.factoryId, db);
  res.json(client);
});
// ---- Party payments ----
// A party owes the amount of its priced deliveries (stock>dispatched moves with an amount), less the amount of
// priced returns (dispatched>stock with an amount), less the payments recorded here. Unpriced moves aren't billed.
function partyBalance(db, clientId) {
  let billed = 0, credit = 0;
  for (const m of db.stockMoves) if (m.clientId === clientId && m.amount != null) { if (m.to === "dispatched") billed += m.amount; else credit += m.amount; }
  const paid = db.partyPayments.filter(p => p.clientId === clientId).reduce((t, p) => t + p.amount, 0);
  return { billed: round2(billed), credit: round2(credit), paid: round2(paid), balance: round2(billed - credit - paid) };
}
const PAY_MODES = ["Cash", "Bank transfer", "UPI", "Cheque", "Other"];
app.post("/api/clients/:id/payments", (req, res) => {
  const body = req.body || {};
  const db = readDb(req.factoryId);
  const client = db.clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: "Party not found." });
  const amount = rateField(body.amount);
  if (amount == null) return res.status(400).json({ error: "Enter the amount received (more than 0)." });
  const date = body.date ? isoDate(body.date) : new Date().toISOString().slice(0, 10);
  if (!date) return res.status(400).json({ error: "Enter a valid date." });
  const mode = PAY_MODES.includes(cleanText(body.mode)) ? cleanText(body.mode) : "Cash";
  const before = partyBalance(db, client.id).balance;
  const pay = { id: id("PAYR"), clientId: client.id, clientName: client.name, amount, date, mode, note: cleanText(body.note).slice(0, 200),
    balanceBefore: before, balanceAfter: round2(before - amount), settled: round2(before - amount) <= 0 && before > 0, by: actor(req), createdAt: new Date().toISOString() };
  db.partyPayments.unshift(pay);
  logEvent(db, req, "party", `${money(amount)} received from ${client.name} (${mode})${pay.note ? ` · ${pay.note}` : ""} · balance ${money(pay.balanceAfter)}${pay.settled ? " · settled" : ""}`);
  writeDb(req.factoryId, db);
  res.status(201).json(pay);
});
app.delete("/api/clients/:id/payments/:pid", (req, res) => {
  const db = readDb(req.factoryId);
  const pay = db.partyPayments.find(p => p.id === req.params.pid && p.clientId === req.params.id);
  if (!pay) return res.status(404).json({ error: "Payment not found." });
  db.partyPayments = db.partyPayments.filter(p => p !== pay);
  logEvent(db, req, "party", `Payment ${money(pay.amount)} from ${pay.clientName} (${pay.date}) removed`);
  writeDb(req.factoryId, db);
  res.json({ removed: pay.id });
});
// A party with delivery history can't be removed (its deliveries and returns would lose their party).
app.delete("/api/clients/:id", requireAdmin, (req, res) => {
  const db = readDb(req.factoryId);
  const client = db.clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: "Party not found." });
  if (db.stockMoves.some(m => m.clientId === client.id) || db.partyPayments.some(p => p.clientId === client.id)) return res.status(409).json({ error: `${client.name} has deliveries on record, so it can't be removed.` });
  db.clients = db.clients.filter(c => c !== client);
  logEvent(db, req, "party", `Party ${client.name} removed`);
  writeDb(req.factoryId, db);
  res.json({ removed: client.id });
});

// ---- Wages ----
// Each loom has a current design (with a wage per saree) and a staff member running it; one staff
// member can run several looms. A dispatch snapshots the staff, design and rate onto the delivery
// record (wage = sarees x rate, every saree counted, also on triple width), so later edits to a
// design never change wages already earned. Deliveries without payoutId are unpaid. Settling
// records a payout with per-staff totals and marks those deliveries with its id: a new period starts.
const money = n => `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const round2 = n => Math.round(n * 100) / 100;
// A loom can have several designs (designIds); designId is the one weaving now and is what a dispatch uses.
// How a factory pays its weavers (factory settings): "saree" = sarees dispatched × the design's rate,
// "shift" = shifts worked (entered on the Wages page) × the factory's wage per shift.
const wageBasisOf = f => f?.wageBasis === "shift" ? "shift" : "saree";
// The factory's shifts [{ name, start, hours, rate }] (an older single `shift` counts as "Shift 1").
const shiftsOf = f => Array.isArray(f?.shifts) ? f.shifts : f?.shift ? [{ name: "Shift 1", ...f.shift }] : [];
const loomDesignIds = loom => loom.designIds?.length ? loom.designIds : loom.designId ? [loom.designId] : [];
function wageFor(db, loom, quantity, designId = loom.designId) {
  const staff = db.staff.find(s => s.id === loom.staffId);
  const design = db.designs.find(d => d.id === designId);
  const out = {};
  if (design) Object.assign(out, { designId: design.id, designNo: design.number, designName: design.name, rate: design.rate });
  if (staff) Object.assign(out, { staffId: staff.id, staffName: staff.name });
  if (staff && design) out.wage = round2(quantity * design.rate);
  return out;
}
// In shift mode a dispatch records the weaver and design but no per-saree wage.
function dispatchWage(factory, db, loom, quantity, designId) {
  const out = wageFor(db, loom, quantity, designId);
  if (wageBasisOf(factory) === "shift") { delete out.wage; delete out.rate; }
  return out;
}
const unpaidDispatches = db => db.deliveries.filter(d => d.wage != null && !d.payoutId);
// Shift entries (db.wageShifts) are unpaid earnings like dispatches: wage = shifts × the rate when entered,
// sarees 0. They are settled in the same payout.
const unpaid = db => [...unpaidDispatches(db), ...db.wageShifts.filter(x => !x.payoutId)];
// Sarees paid for on a dispatch: the dispatched count, unless edited on the Wages page (wageSarees).
// Only the wage changes; production and stock keep the dispatched count.
const wageQty = d => d.wageSarees ?? d.sarees;
const unpaidDeductions = db => db.wageDeductions.filter(x => !x.payoutId);
// Per-staff totals: earnings split by design and rate, minus damage deductions. Biggest net pay first.
//   line: { staffId, staffName, sarees, amount (earned), items, deducted, deductions, net }
function wageLines(deliveries, deductions = []) {
  const byStaff = new Map();
  const lineOf = (staffId, staffName) => byStaff.get(staffId)
    || byStaff.set(staffId, { staffId, staffName, sarees: 0, amount: 0, items: [], deducted: 0, deductions: [], net: 0 }).get(staffId);
  for (const d of deliveries) {
    const line = lineOf(d.staffId, d.staffName);
    line.sarees += wageQty(d);
    line.amount = round2(line.amount + d.wage);
    if (d.shifts != null) { // a shift entry
      line.shifts = (line.shifts || 0) + d.shifts;
      const label = d.shiftName || "Shifts";
      const si = line.items.find(i => i.shift && i.designNo === label && i.rate === d.shiftRate)
        || line.items[line.items.push({ shift: true, designId: null, designNo: label, designName: "", rate: d.shiftRate, sarees: 0, shifts: 0, amount: 0 }) - 1];
      si.shifts += d.shifts;
      si.amount = round2(si.amount + d.wage);
      continue;
    }
    const item = line.items.find(i => !i.shift && i.designId === d.designId && i.rate === d.rate)
      || line.items[line.items.push({ designId: d.designId, designNo: d.designNo, designName: d.designName || "", rate: d.rate, sarees: 0, amount: 0 }) - 1];
    item.sarees += wageQty(d);
    item.amount = round2(item.amount + d.wage);
  }
  for (const x of deductions) {
    const line = lineOf(x.staffId, x.staffName);
    line.deducted = round2(line.deducted + x.amount);
    for (const it of x.items) line.deductions.push({ ...it, note: x.note || "", at: x.createdAt });
  }
  for (const line of byStaff.values()) line.net = round2(line.amount - line.deducted);
  return [...byStaff.values()].sort((a, b) => b.net - a.net);
}
// Damage deductions: sarees with minor or heavy damage, each kind with its own amount per saree.
const DAMAGE_KINDS = { minor: "Minor damage", heavy: "Heavy damage" };
// A design image is a JPEG/PNG/WebP data URL, resized in the browser before upload.
const IMAGE_MAX = 1024 * 1024;
function imageField(value) {
  if (value === undefined) return undefined; // not sent: keep the current image
  if (value === null || value === "") return null; // remove it
  return typeof value === "string" && value.length <= IMAGE_MAX && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : false;
}
function rateField(value) {
  const n = Number(value);
  return value !== "" && value != null && Number.isFinite(n) && n > 0 ? round2(n) : null;
}

// Staff: name, optional phone and optional photo (same rules as a design image).
app.post("/api/staff", (req, res) => {
  const name = cleanText(req.body?.name), phone = cleanText(req.body?.phone), image = imageField(req.body?.image);
  if (!name) return res.status(400).json({ error: "Enter the weaver's name." });
  if (image === false) return res.status(400).json({ error: "The photo could not be used. Choose a JPG or PNG photo." });
  const db = readDb(req.factoryId);
  if (db.staff.some(s => s.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: "A weaver with this name already exists." });
  const now = new Date().toISOString();
  const staff = { id: id("STF"), name, phone, image: image || null, imageAt: image ? now : null, createdAt: now };
  db.staff.unshift(staff);
  logEvent(db, req, "wages", `Weaver ${name} added${phone ? ` · ${phone}` : ""}`);
  writeDb(req.factoryId, db);
  res.status(201).json(noImage(staff));
});

app.get("/api/staff/:id/image", (req, res) => {
  const staff = readDb(req.factoryId).staff.find(s => s.id === req.params.id);
  if (!staff || !staff.image) return res.status(404).json({ error: "No photo for this weaver." });
  res.json({ image: staff.image });
});

app.put("/api/staff/:id", (req, res) => {
  const name = cleanText(req.body?.name), phone = cleanText(req.body?.phone), image = imageField(req.body?.image);
  if (!name) return res.status(400).json({ error: "Enter the weaver's name." });
  if (image === false) return res.status(400).json({ error: "The photo could not be used. Choose a JPG or PNG photo." });
  const db = readDb(req.factoryId);
  const staff = db.staff.find(s => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: "Weaver not found." });
  if (db.staff.some(s => s !== staff && s.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: "A weaver with this name already exists." });
  const old = staff.name;
  Object.assign(staff, { name, phone });
  if (image !== undefined && image !== staff.image) Object.assign(staff, { image, imageAt: image ? new Date().toISOString() : null });
  logEvent(db, req, "wages", `Weaver ${old}${old !== name ? ` renamed to ${name}` : " updated"}${phone ? ` · ${phone}` : ""}`);
  writeDb(req.factoryId, db);
  res.json(noImage(staff));
});

// Unpaid wages and past payouts keep the staff name, so removing someone never loses money owed.
app.delete("/api/staff/:id", requireAdmin, (req, res) => {
  const db = readDb(req.factoryId);
  const staff = db.staff.find(s => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: "Weaver not found." });
  const looms = db.looms.filter(l => l.staffId === staff.id);
  if (looms.length) return res.status(409).json({ error: `${staff.name} still runs ${looms.map(l => l.name).join(", ")}. Change the weaver on those looms first.` });
  db.staff = db.staff.filter(s => s !== staff);
  logEvent(db, req, "wages", `Weaver ${staff.name} removed`);
  writeDb(req.factoryId, db);
  res.json({ removed: staff.id });
});

// Expenses per loom: warp joining, bobbin joining, spares and maintenance. Each has an amount, a date and
// optional details (what, quantity, paid to, bill no., the warp/bobbin joined, a note).
const EXPENSE_KINDS = {
  warp_join: "Warp join", bobbin_join: "Bobbin join", spares: "Spares", maintenance: "Maintenance"
};
const EXPENSE_SUBTYPES = { maintenance: ["Routine service", "Repair", "Breakdown", "Other"] };
function expenseBody(db, body) {
  const loom = db.looms.find(l => l.id === cleanText(body.loomId));
  if (!loom) return { error: "Select the loom." };
  const kind = cleanText(body.kind);
  if (!EXPENSE_KINDS[kind]) return { error: "Select the type of expense." };
  const amount = rateField(body.amount);
  if (amount == null) return { error: "Enter the amount spent." };
  const date = body.date ? isoDate(body.date) : new Date().toISOString().slice(0, 10);
  if (!date) return { error: "Enter a valid date." };
  const qtyRaw = body.qty;
  const qty = qtyRaw === "" || qtyRaw == null ? null : positiveNumber(qtyRaw);
  if (qtyRaw !== "" && qtyRaw != null && qty == null) return { error: "Quantity must be a number above zero." };
  const out = { loomId: loom.id, loomName: loom.name, kind, label: EXPENSE_KINDS[kind], amount, date, qty,
    item: cleanText(body.item).slice(0, 120), vendor: cleanText(body.vendor).slice(0, 120), billNo: cleanText(body.billNo).slice(0, 60),
    subtype: EXPENSE_SUBTYPES[kind]?.includes(cleanText(body.subtype)) ? cleanText(body.subtype) : "",
    note: cleanText(body.note).slice(0, 500), warpId: null, warpName: "", bobbinId: null, bobbinName: "" };
  if ((kind === "spares") && !out.item) return { error: "Enter the spare part." };
  if (kind === "warp_join") {
    const w = db.warps.find(x => x.id === cleanText(body.warpId));
    if (w) { out.warpId = w.id; out.warpName = w.name; }
  }
  if (kind === "bobbin_join") {
    const b = db.bobbins.find(x => x.id === cleanText(body.bobbinId));
    if (b) { out.bobbinId = b.id; out.bobbinName = b.name; }
  }
  return { value: out };
}
const expenseText = x => `${x.label} ${money(x.amount)} on ${x.loomName}` +
  `${x.warpName ? ` · warp ${x.warpName}` : ""}${x.bobbinName ? ` · bobbin ${x.bobbinName}` : ""}${x.subtype ? ` · ${x.subtype}` : ""}` +
  `${x.item ? ` · ${x.item}${x.qty ? ` × ${x.qty}` : ""}` : ""}${x.vendor ? ` · ${x.vendor}` : ""}`;
app.post("/api/expenses", (req, res) => {
  const db = readDb(req.factoryId);
  const r = expenseBody(db, req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  const x = { id: id("EXP"), ...r.value, by: actor(req), createdAt: new Date().toISOString() };
  db.expenses.unshift(x);
  logEvent(db, req, "expense", `Expense added: ${expenseText(x)}`);
  writeDb(req.factoryId, db);
  res.status(201).json(x);
});
app.put("/api/expenses/:id", (req, res) => {
  const db = readDb(req.factoryId);
  const x = db.expenses.find(e => e.id === req.params.id);
  if (!x) return res.status(404).json({ error: "Expense not found." });
  const r = expenseBody(db, req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  Object.assign(x, r.value, { updatedAt: new Date().toISOString() });
  logEvent(db, req, "expense", `Expense edited: ${expenseText(x)}`);
  writeDb(req.factoryId, db);
  res.json(x);
});
app.delete("/api/expenses/:id", (req, res) => {
  const db = readDb(req.factoryId);
  const x = db.expenses.find(e => e.id === req.params.id);
  if (!x) return res.status(404).json({ error: "Expense not found." });
  db.expenses = db.expenses.filter(e => e !== x);
  logEvent(db, req, "expense", `Expense removed: ${expenseText(x)}`);
  writeDb(req.factoryId, db);
  res.json({ removed: x.id });
});

function designBody(body) {
  const number = cleanText(body.number), name = cleanText(body.name), rate = rateField(body.rate), image = imageField(body.image);
  if (!number) return { error: "Enter the design number." };
  if (rate == null) return { error: "Enter the wage per saree (more than 0)." };
  if (image === false) return { error: "The image could not be used. Choose a JPG or PNG photo." };
  // Weaving details, all optional: picks per saree, hours to weave one saree, cost (₹) per pick.
  const opt = (raw, label, whole, places) => {
    if (raw === "" || raw == null) return { value: null };
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || (whole && !Number.isInteger(n))) return { error: `${label} must be ${whole ? "a whole number" : "a number"} above zero.` };
    const k = 10 ** places;
    return { value: Math.round(n * k) / k };
  };
  const picks = opt(body.picks, "Number of picks", true, 0), timing = opt(body.timing, "Timing", false, 2), pickCost = opt(body.pickCost, "Cost per pick", false, 4);
  for (const x of [picks, timing, pickCost]) if (x.error) return { error: x.error };
  return { number, name, rate, image, picks: picks.value, timing: timing.value, pickCost: pickCost.value };
}

app.post("/api/designs", (req, res) => {
  const v = designBody(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const db = readDb(req.factoryId);
  if (db.designs.some(d => d.number.toLowerCase() === v.number.toLowerCase())) return res.status(409).json({ error: "A design with this number already exists." });
  const now = new Date().toISOString();
  const design = { id: id("DSN"), number: v.number, name: v.name, rate: v.rate, picks: v.picks, timing: v.timing, pickCost: v.pickCost, image: v.image || null, imageAt: v.image ? now : null, createdAt: now };
  db.designs.unshift(design);
  logEvent(db, req, "wages", `Design ${v.number}${v.name ? ` (${v.name})` : ""} added · ${money(v.rate)} per saree`);
  writeDb(req.factoryId, db);
  const { image, ...rest } = design;
  res.status(201).json({ ...rest, hasImage: !!image });
});

// A new rate applies to dispatches from now on; wages already earned keep the old rate.
app.put("/api/designs/:id", (req, res) => {
  const v = designBody(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const db = readDb(req.factoryId);
  const design = db.designs.find(d => d.id === req.params.id);
  if (!design) return res.status(404).json({ error: "Design not found." });
  if (db.designs.some(d => d !== design && d.number.toLowerCase() === v.number.toLowerCase())) return res.status(409).json({ error: "A design with this number already exists." });
  const changes = [];
  if (design.number !== v.number) changes.push(`renumbered ${v.number}`);
  if (design.rate !== v.rate) changes.push(`wage ${money(design.rate)} → ${money(v.rate)} per saree`);
  if (v.image !== undefined && v.image !== design.image) changes.push(v.image ? "image updated" : "image removed");
  for (const [k, label] of [["picks", "picks"], ["timing", "timing"], ["pickCost", "cost per pick"]]) {
    if ((design[k] ?? null) !== v[k]) changes.push(`${label} ${design[k] ?? "—"} → ${v[k] ?? "—"}`);
  }
  Object.assign(design, { number: v.number, name: v.name, rate: v.rate, picks: v.picks, timing: v.timing, pickCost: v.pickCost });
  if (v.image !== undefined && v.image !== design.image) Object.assign(design, { image: v.image, imageAt: v.image ? new Date().toISOString() : null });
  logEvent(db, req, "wages", `Design ${design.number} updated${changes.length ? ` · ${changes.join(", ")}` : ""}`);
  writeDb(req.factoryId, db);
  const { image, ...rest } = design;
  res.json({ ...rest, hasImage: !!image });
});

app.get("/api/designs/:id/image", (req, res) => {
  const design = readDb(req.factoryId).designs.find(d => d.id === req.params.id);
  if (!design || !design.image) return res.status(404).json({ error: "No image for this design." });
  res.json({ image: design.image });
});

app.delete("/api/designs/:id", requireAdmin, (req, res) => {
  const db = readDb(req.factoryId);
  const design = db.designs.find(d => d.id === req.params.id);
  if (!design) return res.status(404).json({ error: "Design not found." });
  const looms = db.looms.filter(l => loomDesignIds(l).includes(design.id));
  if (looms.length) return res.status(409).json({ error: `Design ${design.number} is set on ${looms.map(l => l.name).join(", ")}. Change the design on those looms first.` });
  db.designs = db.designs.filter(d => d !== design);
  logEvent(db, req, "wages", `Design ${design.number} removed`);
  writeDb(req.factoryId, db);
  res.json({ removed: design.id });
});

// Sets the loom's current design and staff (either may be cleared with null / "").
app.post("/api/looms/:id/setup", (req, res) => {
  const db = readDb(req.factoryId);
  const loom = db.looms.find(l => l.id === req.params.id);
  if (!loom) return res.status(404).json({ error: "Loom not found." });
  const staffId = cleanText(req.body?.staffId);
  // designIds: every design this loom can weave; designId: the one weaving now (one of them). Sending only designId sets a single design.
  const rawIds = Array.isArray(req.body?.designIds) ? req.body.designIds : cleanText(req.body?.designId) ? [req.body.designId] : [];
  const designIds = [...new Set(rawIds.map(cleanText).filter(Boolean))];
  const designs = designIds.map(i => db.designs.find(d => d.id === i));
  if (designs.some(d => !d)) return res.status(404).json({ error: "Design not found." });
  let designId = cleanText(req.body?.designId);
  if (designId && !designIds.includes(designId)) return res.status(400).json({ error: "The design weaving now must be one of the loom's designs." });
  if (!designId) designId = designIds[0] || "";
  const design = designs.find(d => d.id === designId) || null;
  const staff = staffId ? db.staff.find(s => s.id === staffId) : null;
  if (staffId && !staff) return res.status(404).json({ error: "Weaver not found." });
  const parts = [];
  const before = loomDesignIds(loom).join(), now = designIds.join();
  if ((loom.designId || null) !== (design?.id || null) || before !== now) {
    parts.push(designs.length ? `design${designs.length > 1 ? "s" : ""} ${designs.map(d => d.number).join(", ")}${designs.length > 1 ? ` (weaving ${design.number})` : ` (${money(design.rate)} per saree)`}` : "no design");
  }
  if ((loom.staffId || null) !== (staff?.id || null)) parts.push(staff ? `weaver ${staff.name}` : "no weaver");
  loom.designIds = designIds;
  loom.designId = design ? design.id : null;
  loom.staffId = staff ? staff.id : null;
  if (parts.length) {
    logEvent(db, req, "loom", `Loom ${loom.name} set to ${parts.join(" · ")}`);
    writeDb(req.factoryId, db);
  }
  res.json(loom);
});

// Shift pay: enter the shifts a weaver worked in the open period. The factory's wage per shift (Settings) is
// copied onto the entry, so changing it later doesn't alter shifts already entered. Only unpaid entries can be removed.
app.post("/api/wages/shifts", (req, res) => {
  const body = req.body || {};
  if (wageBasisOf(req.factory) !== "shift") return res.status(409).json({ error: "This factory pays per saree. An admin can switch it to shifts in Settings." });
  const list = shiftsOf(req.factory);
  if (!list.length) return res.status(409).json({ error: "Add a shift (with its wage) in the factory settings first." });
  const shift = list.length === 1 ? list[0] : list.find(x => x.name === cleanText(body.shiftName));
  if (!shift) return res.status(400).json({ error: "Select the shift." });
  const rate = shift.rate;
  if (!(rate > 0)) return res.status(409).json({ error: `Set the wage per shift for ${shift.name} in the factory settings first.` });
  const db = readDb(req.factoryId);
  const staff = db.staff.find(s => s.id === cleanText(body.staffId));
  if (!staff) return res.status(400).json({ error: "Select the weaver." });
  const shifts = Number(body.shifts);
  if (!Number.isFinite(shifts) || shifts <= 0 || shifts > 100 || Math.round(shifts * 2) !== shifts * 2) return res.status(400).json({ error: "Enter the number of shifts (whole or half shifts, above 0)." });
  const entry = { id: id("SFT"), staffId: staff.id, staffName: staff.name, shifts, shiftName: shift.name, shiftRate: rate, wage: round2(shifts * rate), sarees: 0, wageSarees: 0,
    note: cleanText(body.note).slice(0, 200), by: actor(req), createdAt: new Date().toISOString() };
  db.wageShifts.unshift(entry);
  logEvent(db, req, "wages", `${shifts} ${shift.name} shift${shifts === 1 ? "" : "s"} for ${staff.name} · ${shifts} × ${money(rate)} = ${money(entry.wage)}${entry.note ? ` · ${entry.note}` : ""}`);
  writeDb(req.factoryId, db);
  res.status(201).json(entry);
});
app.delete("/api/wages/shifts/:id", (req, res) => {
  const db = readDb(req.factoryId);
  const x = db.wageShifts.find(e => e.id === req.params.id);
  if (!x) return res.status(404).json({ error: "Shift entry not found." });
  if (x.payoutId) return res.status(409).json({ error: "These shifts are already settled." });
  db.wageShifts = db.wageShifts.filter(e => e !== x);
  logEvent(db, req, "wages", `${x.shifts} shift${x.shifts === 1 ? "" : "s"} for ${x.staffName} removed`);
  writeDb(req.factoryId, db);
  res.json({ removed: x.id });
});

// Adds a damage deduction for one staff member in the current (unpaid) period. The amounts per saree
// used are remembered as the factory's defaults (db.deductionRates) for the next deduction.
app.post("/api/wages/deductions", (req, res) => {
  const body = req.body || {};
  const db = readDb(req.factoryId);
  const staff = db.staff.find(s => s.id === cleanText(body.staffId));
  if (!staff) return res.status(400).json({ error: "Select the weaver." });
  const items = [];
  for (const kind of Object.keys(DAMAGE_KINDS)) {
    const raw = body[`${kind}Sarees`], n = raw === "" || raw == null ? 0 : Number(raw);
    if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: `Enter a whole number of sarees for ${DAMAGE_KINDS[kind].toLowerCase()}.` });
    if (!n) continue;
    const rate = rateField(body[`${kind}Rate`]);
    if (rate == null) return res.status(400).json({ error: `Enter the amount per saree for ${DAMAGE_KINDS[kind].toLowerCase()}.` });
    items.push({ kind, label: DAMAGE_KINDS[kind], sarees: n, rate, amount: round2(n * rate) });
    db.deductionRates = { ...db.deductionRates, [kind]: rate };
  }
  if (!items.length) return res.status(400).json({ error: "Enter the number of damaged sarees." });
  const deduction = { id: id("DED"), staffId: staff.id, staffName: staff.name, items, amount: round2(items.reduce((s, i) => s + i.amount, 0)),
    note: cleanText(body.note), by: actor(req), createdAt: new Date().toISOString() };
  db.wageDeductions.unshift(deduction);
  logEvent(db, req, "wages", `Deduction ${money(deduction.amount)} for ${staff.name} · ${items.map(i => `${i.sarees} ${i.label.toLowerCase()} × ${money(i.rate)}`).join(", ")}${deduction.note ? ` · ${deduction.note}` : ""}`);
  writeDb(req.factoryId, db);
  res.status(201).json(deduction);
});

// Only deductions not yet settled can be removed (to correct a mistake).
app.delete("/api/wages/deductions/:id", (req, res) => {
  const db = readDb(req.factoryId);
  const x = db.wageDeductions.find(d => d.id === req.params.id);
  if (!x) return res.status(404).json({ error: "Deduction not found." });
  if (x.payoutId) return res.status(409).json({ error: "This deduction is already settled." });
  db.wageDeductions = db.wageDeductions.filter(d => d !== x);
  logEvent(db, req, "wages", `Deduction ${money(x.amount)} for ${x.staffName} removed`);
  writeDb(req.factoryId, db);
  res.json({ removed: x.id });
});

// Manual correction of one staff member's open period: the sarees and rate paid on each unpaid
// dispatch, and the sarees / amounts of each unpaid deduction. A deduction left with nothing is removed.
//   { staffId, dispatches: [{ id, sarees, rate }], deductions: [{ id, items: [{ sarees, rate } | { amount }] }] }
app.post("/api/wages/edit", (req, res) => {
  const body = req.body || {}, staffId = cleanText(body.staffId);
  const db = readDb(req.factoryId);
  const at = new Date().toISOString(), by = actor(req), changes = [];
  let staffName = db.staff.find(s => s.id === staffId)?.name;
  for (const e of Array.isArray(body.dispatches) ? body.dispatches : []) {
    const d = unpaidDispatches(db).find(x => x.id === e?.id && x.staffId === staffId);
    if (!d) return res.status(400).json({ error: "A dispatch was already settled or no longer exists. Reload and try again." });
    const n = Number(e.sarees), rate = rateField(e.rate);
    if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: `Enter a whole number of sarees for the ${d.loomName} dispatch.` });
    if (rate == null) return res.status(400).json({ error: `Enter the wage per saree for the ${d.loomName} dispatch.` });
    if (n === wageQty(d) && rate === d.rate) continue;
    changes.push(`${d.loomName} ${d.createdAt.slice(0, 10)}: ${wageQty(d)} × ${money(d.rate)} → ${n} × ${money(rate)}`);
    if (n === d.sarees) delete d.wageSarees; else d.wageSarees = n;
    Object.assign(d, { rate, wage: round2(n * rate), wageEditedBy: by, wageEditedAt: at });
    staffName = staffName || d.staffName;
  }
  for (const e of Array.isArray(body.deductions) ? body.deductions : []) {
    const x = unpaidDeductions(db).find(y => y.id === e?.id && y.staffId === staffId);
    if (!x) return res.status(400).json({ error: "A deduction was already settled or no longer exists. Reload and try again." });
    const edits = Array.isArray(e.items) ? e.items : [];
    if (edits.length !== x.items.length) return res.status(400).json({ error: "The deduction changed. Reload and try again." });
    const items = [];
    for (const [i, it] of x.items.entries()) {
      const v = edits[i] || {};
      if (DAMAGE_KINDS[it.kind]) {
        const n = Number(v.sarees);
        if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: `Enter a whole number of sarees for ${it.label.toLowerCase()}.` });
        if (!n) continue;
        const rate = rateField(v.rate);
        if (rate == null) return res.status(400).json({ error: `Enter the amount per saree for ${it.label.toLowerCase()}.` });
        items.push({ ...it, sarees: n, rate, amount: round2(n * rate) });
      } else {
        if (v.amount === "" || v.amount == null || Number(v.amount) === 0) continue;
        const amount = rateField(v.amount);
        if (amount == null) return res.status(400).json({ error: `Enter an amount above 0 for ${it.label.toLowerCase()}.` });
        items.push({ ...it, amount });
      }
    }
    const amount = round2(items.reduce((s, i) => s + i.amount, 0));
    if (amount === x.amount && items.length === x.items.length && items.every((it, i) => it.sarees === x.items[i].sarees && it.rate === x.items[i].rate)) continue;
    staffName = staffName || x.staffName;
    if (!items.length) {
      db.wageDeductions = db.wageDeductions.filter(y => y !== x);
      changes.push(`deduction ${money(x.amount)} removed`);
    } else {
      changes.push(`deduction ${money(x.amount)} → ${money(amount)}`);
      Object.assign(x, { items, amount, editedBy: by, editedAt: at });
    }
  }
  if (!changes.length) return res.json({ changed: 0 });
  logEvent(db, req, "wages", `Wages edited for ${staffName || "weaver"} · ${changes.join(" · ")}`);
  writeDb(req.factoryId, db);
  res.json({ changed: changes.length });
});

// Closes the wage period for every staff member, or only for staffIds: their unpaid wages and
// deductions go into one payout record, kept as history. Other staff keep their open period.
// Staff with only a carried balance (nothing new) are left out.
app.post("/api/wages/settle", (req, res) => {
  const db = readDb(req.factoryId);
  const pick = Array.isArray(req.body?.staffIds) ? new Set(req.body.staffIds.map(String)) : null;
  if (pick && !pick.size) return res.status(400).json({ error: "Select the weavers to settle." });
  const due = new Set([...unpaid(db).map(d => d.staffId), ...unpaidDeductions(db).filter(x => !x.carry).map(x => x.staffId)]);
  const mine = x => due.has(x.staffId) && (!pick || pick.has(x.staffId));
  const list = unpaid(db).filter(mine), cuts = unpaidDeductions(db).filter(mine);
  if (!list.length && !cuts.length) return res.status(400).json({ error: pick ? "The selected weavers have no unpaid wages to settle." : "There are no unpaid wages to settle." });
  const at = new Date().toISOString();
  // Other deductions typed in while settling ({ staffId: { amount, note } }, e.g. an advance): saved as
  // deductions of kind "other" and settled in this payout.
  const adj = req.body?.adjustments && typeof req.body.adjustments === "object" ? req.body.adjustments : {};
  for (const [staffId, a] of Object.entries(adj)) {
    const raw = a?.amount;
    if (raw === "" || raw == null || Number(raw) === 0) continue;
    const amount = rateField(raw);
    if (amount == null) return res.status(400).json({ error: "Other deductions must be an amount above 0." });
    const staff = db.staff.find(s => s.id === staffId);
    if (!staff || !mine({ staffId })) return res.status(400).json({ error: "Other deductions can only be for weavers being settled." });
    const note = cleanText(a.note) || "Other deduction";
    cuts.push({ id: id("DED"), staffId, staffName: staff.name, items: [{ kind: "other", label: note, sarees: 0, rate: 0, amount }],
      amount, note: "", by: actor(req), createdAt: at });
  }
  const added = cuts.filter(x => x.createdAt === at && x.items[0].kind === "other");
  db.wageDeductions.unshift(...added);
  const earned = round2(list.reduce((s, d) => s + d.wage, 0)), deducted = round2(cuts.reduce((s, x) => s + x.amount, 0));
  for (const x of added) logEvent(db, req, "wages", `Other deduction ${money(x.amount)} for ${x.staffName} · ${x.items[0].label}`);
  // Deductions bigger than a staff member's earnings: pay 0 and carry the rest into the next period.
  const lines = wageLines(list, cuts), carries = [];
  for (const line of lines) {
    if (line.net >= 0) continue;
    line.carried = -line.net;
    line.net = 0;
    carries.push({ id: id("DED"), staffId: line.staffId, staffName: line.staffName, carry: true,
      items: [{ kind: "carry", label: "Balance from last settlement", sarees: 0, rate: 0, amount: line.carried }],
      amount: line.carried, note: "", by: actor(req), createdAt: at });
  }
  const payout = {
    id: id("PAY"), from: [...list, ...cuts].reduce((m, d) => d.createdAt < m ? d.createdAt : m, at), to: at,
    sarees: list.reduce((s, d) => s + wageQty(d), 0), earned, deducted, carried: round2(carries.reduce((s, x) => s + x.amount, 0)),
    total: round2(lines.reduce((s, l) => s + l.net, 0)), lines, partial: !!pick && [...due].some(id => !pick.has(id)),
    note: cleanText(req.body?.note), by: actor(req), createdAt: at
  };
  const shiftTotal = list.reduce((t, d) => t + (d.shifts || 0), 0);
  for (const d of [...list, ...cuts]) d.payoutId = payout.id;
  db.wageDeductions.unshift(...carries);
  db.wagePayouts.unshift(payout);
  logEvent(db, req, "wages", `Wages settled${payout.partial ? ` for ${lines.map(l => l.staffName).join(", ")}` : ""} · ${money(payout.total)} to ${payout.lines.length} weaver${payout.lines.length === 1 ? "" : "s"} for ${shiftTotal ? `${shiftTotal} shift${shiftTotal === 1 ? "" : "s"}${payout.sarees ? ` + ${sarees(payout.sarees)}` : ""}` : sarees(payout.sarees)}${deducted ? ` (${money(earned)} earned − ${money(deducted)} deductions)` : ""}${payout.carried ? ` · ${money(payout.carried)} carried to next period` : ""}${payout.note ? ` · ${payout.note}` : ""}`);
  writeDb(req.factoryId, db);
  res.status(201).json(payout);
});

// Sarees are a ledger of buckets. A loom delivery puts sarees in "sent" (on the way to the
// godown); each stock move takes qty from `from` and adds it to `to`; an adjustment
// (type "adjust", no `from`) adds a signed qty to one bucket. Counts are derived, never stored.
//   Per warp (Process page): sent -> delivered (godown) -> process -> folding
//   Checking (sort):          delivered -> process | mai | damage    (sarees are checked before process)
//   Add to stock (sort):      folding -> stock | mai | lot | damage   (both still tagged with the warp)
//   Pooled (Stock page, all warps together, moves carry no warp):
//     mai -> cleaning -> stock · stock -> damage (damage return) · stock <-> dispatched (party)
//     damage -> returned (to the loom owner, which is the factory owner) · lot stays
const STOCK_BUCKETS = ["sent", "delivered", "process", "folding", "stock", "mai", "cleaning", "lot", "damage", "dispatched", "returned"];
const PROCESS_MOVES = new Set(["sent>delivered", "delivered>process", "process>folding"]);
const POOL_MOVES = new Set(["mai>cleaning", "cleaning>stock", "stock>damage", "stock>dispatched", "dispatched>stock", "damage>returned"]);
// Splits: checking at the godown (before process) and Add to stock (after folding).
const SORTS = { delivered: ["process", "mai", "damage"], process: ["mai", "damage"], folding: ["stock", "mai", "lot", "damage"] };
const ADJUSTABLE = ["stock", "mai", "lot", "damage"];
const WARP_ADJUSTABLE = ["delivered", "process", "folding"];
const STOCK_LABEL = { sent: "sent from looms and not yet received", delivered: "at the godown", process: "in process", folding: "in folding",
  stock: "in stock", mai: "with greese (mai)", cleaning: "at cleaning", lot: "in lot", damage: "in damage" };
// warpId given: that warp's buckets. No warpId: every warp together (the stock pool).
function stockFor(db, warpId) {
  const st = Object.fromEntries(STOCK_BUCKETS.map(b => [b, 0]));
  const mine = x => !warpId || x.warpId === warpId;
  st.sent = db.deliveries.filter(mine).reduce((s, d) => s + d.sarees, 0);
  for (const m of db.stockMoves) {
    if (!mine(m)) continue;
    if (m.from) st[m.from] -= m.qty;
    st[m.to] += m.qty;
  }
  // Stock + Wages factories skip the Process step: dispatched sarees go straight to stock (anything already
  // on the way counts as stock too). Derived on read, so nothing is rewritten and switching back is safe.
  if (db.direct) {
    st.stock += st.sent + st.delivered + st.process + st.folding;
    st.sent = st.delivered = st.process = st.folding = 0;
  }
  return st;
}
// Called when a factory stops skipping the Process step (see stockFor): whatever sat in sent / godown / process /
// folding and counted as stock becomes real stock moves, so every count stays the same. Reads with the normal
// migrations, and with the direct view off so the old buckets are visible.
function flushToStock(factoryId) {
  const db = readDb(factoryId);
  Object.defineProperty(db, "direct", { value: false, enumerable: false, configurable: true });
  const at = new Date().toISOString(), moves = [];
  for (const w of db.warps) {
    const st = stockFor(db, w.id);
    for (const from of ["sent", "delivered", "process", "folding"]) {
      if (st[from]) moves.push({ id: id("MOV"), warpId: w.id, warpName: w.name, from, to: "stock", qty: st[from], auto: true, note: "Moved to stock when Process was turned back on", by: "system", createdAt: at });
    }
  }
  if (!moves.length) return;
  db.stockMoves.unshift(...moves);
  writeDb(factoryId, db);
}
// Sarees a party still holds: dispatched to them minus their returns.
function partyHolds(db, clientId) {
  return db.stockMoves.filter(m => m.clientId === clientId)
    .reduce((s, m) => s + (m.to === "dispatched" ? m.qty : m.from === "dispatched" ? -m.qty : 0), 0);
}
// Each "send for cleaning" is a batch; "back from cleaning" names the batch it came from
// (batchId). Returns saved before batches existed come off the oldest batches first. Newest first.
function cleaningBatches(db) {
  const batches = [], loose = [];
  for (const m of [...db.stockMoves].reverse()) {
    if (m.from === "mai" && m.to === "cleaning") batches.push({ id: m.id, sentAt: m.createdAt, qty: m.qty, note: m.note || "", by: m.by || "", back: 0 });
    else if (m.from === "cleaning" && m.to === "stock") {
      const b = m.batchId && batches.find(x => x.id === m.batchId);
      if (b) b.back += m.qty; else loose.push(m.qty);
    }
  }
  for (let q of loose) for (const b of batches) { const take = Math.min(q, b.qty - b.back); b.back += take; q -= take; if (!q) break; }
  return batches.map(b => ({ ...b, pending: b.qty - b.back })).reverse();
}
const onlyLeft = (n, from, warp) => `Only ${sarees(n)} ${STOCK_LABEL[from]}${warp ? ` for ${warp.name}` : ""}.`;

// Saves the order of warp or loom tiles after a drag. ids lists one column/section top to bottom;
// tiles without an order (new ones) sort above ordered ones.
app.post("/api/order", (req, res) => {
  const kind = req.body?.kind;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (!["warps", "bobbins", "looms"].includes(kind) || !ids) return res.status(400).json({ error: "Invalid order." });
  const db = readDb(req.factoryId);
  ids.forEach((tid, i) => { const item = db[kind].find(x => x.id === tid); if (item) item.order = i; });
  writeDb(req.factoryId, db);
  res.json({ ok: true });
});

app.post("/api/stock/move", (req, res) => {
  const body = req.body || {};
  const { from, to } = body;
  const key = `${from}>${to}`;
  const qty = Number(body.qty);
  if (!PROCESS_MOVES.has(key) && !POOL_MOVES.has(key)) return res.status(400).json({ error: "This stock move is not allowed." });
  if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: "Enter a positive whole number of sarees." });
  const db = readDb(req.factoryId);
  const move = { id: id("MOV"), from, to, qty, note: cleanText(body.note), by: actor(req), createdAt: new Date().toISOString() };
  if (PROCESS_MOVES.has(key)) {
    const warp = db.warps.find(w => w.id === cleanText(body.warpId));
    if (!warp) return res.status(404).json({ error: "Warp not found." });
    const available = stockFor(db, warp.id)[from];
    if (qty > available) return res.status(400).json({ error: onlyLeft(available, from, warp) });
    Object.assign(move, { warpId: warp.id, warpName: warp.name });
  } else if (from === "dispatched" || to === "dispatched") {
    const client = db.clients.find(c => c.id === cleanText(body.clientId));
    if (!client) return res.status(400).json({ error: to === "dispatched" ? "Select the party to dispatch to." : "Select the party returning the sarees." });
    const available = from === "dispatched" ? partyHolds(db, client.id) : stockFor(db).stock;
    if (qty > available) return res.status(400).json({ error: from === "dispatched" ? `${client.name} has only ${sarees(available)} to return.` : onlyLeft(available, "stock") });
    Object.assign(move, { clientId: client.id, clientName: client.name, lrNumber: cleanText(body.lrNumber) });
    // Optional design on a delivery: priced with this party's rate for it (rate and amount are saved on the move).
    // A party return can name a design too: its amount is credited to the party's balance.
    const designId = cleanText(body.designId);
    if (designId) {
      const design = db.designs.find(d => d.id === designId), rate = client.rates?.[designId];
      if (!design) return res.status(400).json({ error: "Design not found." });
      if (!(rate > 0)) return res.status(400).json({ error: `${client.name} has no rate for design ${design.number}. Set it on the Parties page first.` });
      Object.assign(move, { designId, designNo: design.number, designName: design.name || "", rate, amount: round2(qty * rate) });
    }
  } else {
    const available = stockFor(db)[from];
    if (qty > available) return res.status(400).json({ error: onlyLeft(available, from) });
  }
  if (key === "cleaning>stock") {
    const batch = cleaningBatches(db).find(b => b.id === cleanText(body.batchId));
    if (!batch) return res.status(400).json({ error: "Select which cleaning batch came back." });
    if (qty > batch.pending) return res.status(400).json({ error: `Only ${sarees(batch.pending)} of that batch are still at cleaning.` });
    Object.assign(move, { batchId: batch.id, batchSentAt: batch.sentAt, batchNote: batch.note });
  }
  // Damaged sarees go back to the loom owner, who is the factory owner.
  if (to === "returned") Object.assign(move, { ownerName: req.factory.ownerName || "", ownerPhone: req.factory.ownerPhone || "" });
  db.stockMoves.unshift(move);
  logEvent(db, req, moveType(move), moveText(move));
  writeDb(req.factoryId, db);
  res.status(201).json({ move, stock: stockFor(db, move.warpId), pool: stockFor(db) });
});

// Splits one warp's sarees in one go: from "process" (greese / damage found while in process, which come off the process count), from "delivered" (checking before process) into process,
// mai and damage, or from "folding" (Add to stock) into stock, mai, lot and damage.
app.post("/api/stock/sort", (req, res) => {
  const body = req.body || {};
  const from = body.from || "folding";
  if (!SORTS[from]) return res.status(400).json({ error: "Unknown stage." });
  const counts = SORTS[from].map(to => [to, body[to] === "" || body[to] == null ? 0 : Number(body[to])]);
  if (counts.some(([, n]) => !Number.isInteger(n) || n < 0)) return res.status(400).json({ error: "Enter whole numbers of sarees (0 or more)." });
  const total = counts.reduce((s, [, n]) => s + n, 0);
  if (!total) return res.status(400).json({ error: `Enter how many sarees go to ${SORTS[from].map(t => STOCK_NAME[t].toLowerCase()).join(", ")}.` });
  const db = readDb(req.factoryId);
  const warp = db.warps.find(w => w.id === cleanText(body.warpId));
  if (!warp) return res.status(404).json({ error: "Warp not found." });
  const available = stockFor(db, warp.id)[from];
  if (total > available) return res.status(400).json({ error: onlyLeft(available, from, warp) });
  const createdAt = new Date().toISOString(), by = actor(req);
  const moves = counts.filter(([, n]) => n > 0).map(([to, qty]) => ({ id: id("MOV"), warpId: warp.id, warpName: warp.name, from, to, qty, by, createdAt }));
  db.stockMoves.unshift(...moves);
  const split = moves.map(m => `${m.qty} ${STOCK_NAME[m.to].toLowerCase()}`).join(", ");
  logEvent(db, req, "process", from === "delivered" ? `${sarees(total)} of ${warp.name} checked · ${split}` : from === "process" ? `${sarees(total)} of ${warp.name} taken out of process · ${split}` : `${sarees(total)} of ${warp.name} added to stock section · ${split}`);
  writeDb(req.factoryId, db);
  res.status(201).json({ moves, stock: stockFor(db, warp.id), pool: stockFor(db) });
});

// Corrects the pooled stock / mai / lot / damage count to `count`, recording the difference.
app.post("/api/stock/adjust", (req, res) => {
  const body = req.body || {};
  const bucket = body.bucket;
  const count = Number(body.count);
  const db = readDb(req.factoryId);
  // With a warpId: correct one Process stage of that warp. Without: the pooled stock/mai/lot/damage.
  const warp = body.warpId ? db.warps.find(w => w.id === cleanText(body.warpId)) : null;
  if (body.warpId && !warp) return res.status(404).json({ error: "Warp not found." });
  if (!(warp ? WARP_ADJUSTABLE : ADJUSTABLE).includes(bucket)) return res.status(400).json({ error: warp ? "Only the godown, process and folding counts can be corrected here." : "Only stock, mai, lot and damage can be adjusted." });
  if (!Number.isInteger(count) || count < 0) return res.status(400).json({ error: "Enter the correct count as a whole number (0 or more)." });
  const delta = count - stockFor(db, warp?.id)[bucket];
  if (!delta) return res.status(400).json({ error: `The count is already ${count}.` });
  const move = { id: id("ADJ"), type: "adjust", to: bucket, qty: delta, count, note: cleanText(body.note), by: actor(req), createdAt: new Date().toISOString(),
    ...(warp ? { warpId: warp.id, warpName: warp.name } : {}) };
  db.stockMoves.unshift(move);
  logEvent(db, req, "stock", moveText(move));
  writeDb(req.factoryId, db);
  res.status(201).json({ move, pool: stockFor(db) });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Unexpected server error." });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`My Thari running on http://localhost:${PORT}`);
  store.initAccounts();
  const { factories, users } = store.readAccounts();
  console.log(`Data:    ${DATA_DIR} (${factories.length} factor${factories.length === 1 ? "y" : "ies"}, ${users.length} user${users.length === 1 ? "" : "s"})`);
  const cfg = backupConfig();
  console.log(`Backups: ${cfg.dir} (daily, last ${cfg.keepDays} days kept)`);
  backupNow();
  safeArchiveLogs();
  // Hourly: refresh today's backup and move log entries older than 30 days to a CSV archive.
  setInterval(() => { backupNow(); safeArchiveLogs(); }, 60 * 60 * 1000);
  if (process.env.OPEN_BROWSER) openBrowser(`http://localhost:${PORT}`);
});
server.on("error", err => {
  // Double-clicking the launcher while the app is already running: just show the open app.
  if (err.code === "EADDRINUSE") {
    console.log(`My Thari is already running on port ${PORT}. Opening it in the browser.`);
    if (process.env.OPEN_BROWSER) openBrowser(`http://localhost:${PORT}`);
    setTimeout(() => process.exit(0), 1500);
    return;
  }
  throw err;
});
function openBrowser(url) {
  const { exec } = require("child_process");
  const cmd = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, err => { if (err) console.log(`Open ${url} in your browser.`); });
}
