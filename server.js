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

app.use(express.json());
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
  for (const key of ["clients", "stockMoves"]) {
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
function settleSpentWarps(db) {
  let changed = false;
  for (const warp of db.warps) {
    if (isClosed(warp) || !isSpent(warp)) continue;
    const loom = db.looms.find(l => l.id === warp.assignedLoomId);
    if (loom) { loom.warpId = null; loom.status = "Warp Completed"; }
    warp.assignedLoomId = null;
    warp.status = "Completed";
    warp.completedAt = new Date().toISOString();
    changed = true;
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
  if (m.type === "adjust") return `${STOCK_NAME[m.to] || m.to} adjusted ${m.qty > 0 ? "+" : ""}${m.qty}${m.count != null ? ` (now ${m.count})` : ""}${why}`;
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
    "stock>dispatched": `${sarees(m.qty)}${of} delivered to ${m.clientName}${m.lrNumber ? ` · LR ${m.lrNumber}` : ""}`,
    "dispatched>stock": `${sarees(m.qty)} returned by ${m.clientName}, added to stock`,
    "damage>returned": `${sarees(m.qty)} damaged returned to loom owner${m.ownerName ? ` ${m.ownerName}` : ""}`
  }[`${m.from}>${m.to}`];
  return (text || `${sarees(m.qty)} moved ${m.from} → ${m.to}`) + why;
}
const STOCK_NAME = { process: "Process", stock: "Stock", mai: "Greese (mai)", lot: "Lot", damage: "Damage" };
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

// Returns [httpStatus, message] if the warp cannot be put on the loom, else null.
function assignError(loom, warp) {
  if (loom.stoppedAt) return [409, "This loom is stopped. Resume it before assigning a warp."];
  if (warp.status === "Discarded") return [409, "This warp has been discarded."];
  if (loom.warpId) return [409, "This loom already has a warp assigned. Finish or remove its current warp first."];
  if (warp.widthType !== loom.widthType) return [400, "Warp width type must match the loom width type."];
  if (warp.assignedLoomId) return [409, "This warp is already assigned to another active loom."];
  if (warp.status === "Completed" || isSpent(warp)) return [400, `This warp is completed (less than ${SAREE_M} m left).`];
  if (warp.status === "Ordered") return [400, "This warp is still on order. Mark it ready before assigning it to a loom."];
  return null;
}
function assignWarp(loom, warp) {
  loom.warpId = warp.id;
  loom.status = "Running";
  warp.assignedLoomId = loom.id;
  warp.status = "In Use";
  warp.startedAt = new Date().toISOString();
}

app.get("/api/health", (_req, res) => res.json({ status: "ok", app: "My Thari" }));
app.use("/api/auth", authRouter());
app.use("/api/admin", requireAuth, requireAdmin, require("./admin")());
// Everything below works on one factory's data and needs a signed-in user with access to it.
app.use(["/api/data", "/api/warps", "/api/looms", "/api/deliveries", "/api/clients", "/api/stock", "/api/order"], requireAuth, factoryScope);
app.get("/api/data", (req, res) => res.json(readDb(req.factoryId)));

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
    plannedMeters, wovenMeters: 0, warpId: warp ? warp.id : null,
    status: warp ? "Running" : "Available", createdAt: new Date().toISOString()
  };
  if (warp) {
    warp.assignedLoomId = loom.id;
    warp.status = "In Use";
    warp.startedAt = loom.createdAt;
  }
  db.looms.unshift(loom);
  logEvent(db, req, "loom", `Loom ${name} added · ${widthType} width${warp ? ` · running ${warp.name}` : ""}`);
  writeDb(req.factoryId, db);
  res.status(201).json(loom);
});

app.post("/api/deliveries", (req, res) => {
  const body = req.body || {};
  const loomId = cleanText(body.loomId);
  const quantity = Number(body.sarees);
  const note = cleanText(body.note);
  const lrNumber = cleanText(body.lrNumber);
  const db = readDb(req.factoryId);
  const loom = db.looms.find(l => l.id === loomId);
  if (!loom) return res.status(404).json({ error: "Select a valid loom." });
  if (loom.stoppedAt) return res.status(409).json({ error: "This loom is stopped. Resume it before recording a delivery." });
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return res.status(400).json({ error: "Number of sarees must be a positive whole number." });
  }
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
  warp.remainingMeters = Math.max(0, Number((warp.remainingMeters - metersToReduce).toFixed(2)));
  loom.wovenMeters = Number((loom.wovenMeters + metersToReduce).toFixed(2));
  settleSpentWarps(db);
  const delivery = {
    id: id("DEL"), loomId: loom.id, loomName: loom.name, warpId: warp.id, warpName: warp.name,
    widthType: loom.widthType, sarees: quantity, metersReduced: Number(metersToReduce.toFixed(2)),
    remainingMeters: warp.remainingMeters, note, lrNumber, createdAt: new Date().toISOString()
  };
  db.deliveries.unshift(delivery);
  logEvent(db, req, "dispatch", `${sarees(quantity)} dispatched from ${loom.name} (${warp.name}) · ${delivery.metersReduced} m used, ${warp.remainingMeters} m left${lrNumber ? ` · LR ${lrNumber}` : ""}${warp.status === "Completed" ? ` · ${warp.name} completed, ${loom.name} free` : ""}`);
  writeDb(req.factoryId, db);
  res.status(201).json({ delivery, loom, warp });
});

// Moves a warp between board stages: ordered <-> ready <-> running. "Done" is reached
// only through deliveries using up the warp, so it is never a valid target here.
app.post("/api/warps/:id/move", (req, res) => {
  const body = req.body || {};
  const db = readDb(req.factoryId);
  const warp = db.warps.find(w => w.id === req.params.id);
  if (!warp) return res.status(404).json({ error: "Warp not found." });
  if (warp.status === "Discarded") return res.status(409).json({ error: "Discarded warps cannot be moved." });
  if (warp.status === "Completed" || isSpent(warp)) return res.status(409).json({ error: "Completed warps cannot be moved." });
  const date = body.date ? isoDate(body.date) : new Date().toISOString().slice(0, 10);
  if (!date) return res.status(400).json({ error: "Enter a valid date." });
  const from = warp.assignedLoomId ? "running" : warp.status === "Ordered" ? "ordered" : "ready";
  const to = body.to;
  if (from === to) return res.json({ warp });
  const offLoom = db.looms.find(l => l.id === warp.assignedLoomId);

  if (to === "ordered") {
    if (from !== "ready") return res.status(409).json({ error: "Take the warp off its loom before moving it back to ordered." });
    if (warp.remainingMeters < warp.originalMeters) return res.status(409).json({ error: "This warp has already been woven and cannot go back to ordered." });
    warp.status = "Ordered";
    delete warp.readyDate;
  } else if (to === "ready") {
    if (from === "running") {
      const loom = db.looms.find(l => l.id === warp.assignedLoomId);
      if (loom) { loom.warpId = null; loom.status = "Available"; }
      warp.assignedLoomId = null;
      delete warp.startedAt;
    } else {
      warp.readyDate = date;
    }
    warp.status = "Ready";
  } else if (to === "running") {
    const loom = db.looms.find(l => l.id === cleanText(body.loomId));
    if (!loom) return res.status(404).json({ error: "Select a loom to run this warp on." });
    if (from === "ordered") { warp.status = "Ready"; warp.readyDate = date; }
    const err = assignError(loom, warp);
    if (err) return res.status(err[0]).json({ error: err[1] });
    assignWarp(loom, warp);
  } else {
    return res.status(400).json({ error: "Warps move to Done automatically when all their meters are delivered." });
  }
  const loomNow = db.looms.find(l => l.id === warp.assignedLoomId);
  logEvent(db, req, "warp", to === "ordered" ? `Warp ${warp.name} moved back to ordered`
    : to === "running" ? `Warp ${warp.name} started on ${loomNow ? loomNow.name : "a loom"}`
    : from === "running" ? `Warp ${warp.name} taken off ${offLoom ? offLoom.name : "its loom"}, back to ready` : `Warp ${warp.name} marked ready`);
  writeDb(req.factoryId, db);
  res.json({ warp });
});

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

app.post("/api/warps/:id/discard", requireAdmin, (req, res) => {
  const db = readDb(req.factoryId);
  const warp = db.warps.find(w => w.id === req.params.id);
  if (!warp) return res.status(404).json({ error: "Warp not found." });
  if (isClosed(warp)) return res.status(409).json({ error: `This warp is already ${warp.status.toLowerCase()}.` });
  if (warp.assignedLoomId) return res.status(409).json({ error: "This warp is on a loom. Take it off the loom (drag it to Ready) before discarding." });
  warp.status = "Discarded";
  warp.discardedAt = new Date().toISOString();
  warp.discardReason = cleanText(req.body?.reason);
  logEvent(db, req, "warp", `Warp ${warp.name} discarded${warp.discardReason ? ` · ${warp.discardReason}` : ""}`);
  writeDb(req.factoryId, db);
  res.json({ warp });
});

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

// Removing a loom is a deliberate two-step action: it must be stopped first. A warp still on
// it goes back to Ready. Delivery records keep their loomName snapshot, so history survives.
app.delete("/api/looms/:id", requireAdmin, (req, res) => {
  const db = readDb(req.factoryId);
  const index = db.looms.findIndex(l => l.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: "Loom not found." });
  const loom = db.looms[index];
  if (!loom.stoppedAt) return res.status(409).json({ error: "Stop the loom before removing it." });
  const warp = db.warps.find(w => w.id === loom.warpId);
  if (warp) {
    warp.assignedLoomId = null;
    warp.status = "Ready";
    delete warp.startedAt;
  }
  db.looms.splice(index, 1);
  logEvent(db, req, "loom", `Loom ${loom.name} removed${warp ? ` · ${warp.name} back to ready` : ""}`);
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
const SORTS = { delivered: ["process", "mai", "damage"], folding: ["stock", "mai", "lot", "damage"] };
const ADJUSTABLE = ["stock", "mai", "lot", "damage"];
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
  return st;
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
  if (!["warps", "looms"].includes(kind) || !ids) return res.status(400).json({ error: "Invalid order." });
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

// Splits one warp's sarees in one go: from "delivered" (checking before process) into process,
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
  logEvent(db, req, "process", from === "delivered" ? `${sarees(total)} of ${warp.name} checked · ${split}` : `${sarees(total)} of ${warp.name} added to stock section · ${split}`);
  writeDb(req.factoryId, db);
  res.status(201).json({ moves, stock: stockFor(db, warp.id), pool: stockFor(db) });
});

// Corrects the pooled stock / mai / lot / damage count to `count`, recording the difference.
app.post("/api/stock/adjust", (req, res) => {
  const body = req.body || {};
  const bucket = body.bucket;
  const count = Number(body.count);
  if (!ADJUSTABLE.includes(bucket)) return res.status(400).json({ error: "Only stock, mai, lot and damage can be adjusted." });
  if (!Number.isInteger(count) || count < 0) return res.status(400).json({ error: "Enter the correct count as a whole number (0 or more)." });
  const db = readDb(req.factoryId);
  const delta = count - stockFor(db)[bucket];
  if (!delta) return res.status(400).json({ error: `The count is already ${count}.` });
  const move = { id: id("ADJ"), type: "adjust", to: bucket, qty: delta, count, note: cleanText(body.note), by: actor(req), createdAt: new Date().toISOString() };
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
