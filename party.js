// Party (job-work giver) API, mounted at /api/party behind requireAuth + requireParty.
//
// A party registers the factories that weave for it (factory.partyIds), gives each factory owner a login
// (role "user" with that factory in factoryIds), and owns the setup there: looms (loom.partyId), designs
// (design.partyId), job orders, and what the owner may do on its looms (factory.ownerPerms[partyId]).
// The owner runs the looms; the party sees everything on its looms live, approves warp/weft requests,
// sends announcements and confirms the sarees it receives.
//
// Per-factory collections (factories/<id>.json):
//   jobOrders     { id, code, partyId, designId, designNo, designName, target, widthType, loomIds, note, status: open|closed, createdAt }
//   requests      { id, kind: warp|bobbin, loomId, loomName, partyId, widthType, sarees, meters, needBy, note,
//                   status: pending|approved|rejected|cancelled, by, createdAt, decidedBy?, decidedAt?, reason?, itemId?, itemName? }
//   shipments     { id, partyId, jobOrderId, jobCode, qty, lrNumber, note, by, createdAt, receivedAt?, receivedBy?, issue? }
//   announcements { id, partyId, partyName, kind: warp|design|holiday|general, title, body, ackRequired, acks: [{ userId, name, at }], by, createdAt }
const express = require("express");
const store = require("./store");

// What a factory owner may do on a party's looms unless the party turns it off.
const DEFAULT_PERMS = { dispatch: true, stop: true, warp: true, receive: true, request: true, ship: true };
const PERM_KEYS = Object.keys(DEFAULT_PERMS);
const permsFor = (factory, partyId) => ({ ...DEFAULT_PERMS, ...(factory?.ownerPerms?.[partyId] || {}) });
// A factory is party-managed once any party has registered it: looms and designs are then set up by the party.
const partyManaged = factory => (factory?.partyIds || []).length > 0;

const SAREE_M = 6.3;
const perMeter = widthType => widthType === "triple" ? 3 / SAREE_M : 1 / SAREE_M;
// Whole sarees a warp/bobbin can still weave (sets of 3 on triple width).
const sareesLeft = item => {
  const per = item.widthType === "triple" ? 3 : 1;
  return Math.floor((item.remainingMeters + 1e-9) / SAREE_M) * per;
};
const metersFor = (sarees, widthType) => Math.round(sarees * SAREE_M / (widthType === "triple" ? 3 : 1) * 100) / 100;

// Where a job order stands: woven = dispatched from its looms; sent = shipped to the party; received = confirmed by the party.
function jobStats(db, jo) {
  const woven = db.deliveries.filter(d => d.jobOrderId === jo.id).reduce((s, d) => s + d.sarees, 0);
  const ships = (db.shipments || []).filter(s => s.jobOrderId === jo.id);
  const sent = ships.reduce((s, x) => s + x.qty, 0);
  const received = ships.filter(x => x.receivedAt).reduce((s, x) => s + x.qty, 0);
  return {
    woven, sent, received,
    toWeave: Math.max(0, jo.target - woven),
    atFactory: Math.max(0, woven - sent),
    onWay: Math.max(0, sent - received),
    pending: Math.max(0, jo.target - received)
  };
}

const text = v => (typeof v === "string" ? v.trim() : "");
const posInt = v => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const dayKey = d => { const x = new Date(d); return `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`; };

module.exports = function partyRouter(h) {
  // h: { readDb, writeDb, logEvent, loomState, newId }
  const router = express.Router();

  // The factory named in the URL, if this party registered it.
  function own(req, res) {
    const accounts = store.readAccounts();
    const factory = accounts.factories.find(f => f.id === req.params.fid && (f.partyIds || []).includes(req.party.id));
    if (!factory) { res.status(404).json({ error: "Factory not found." }); return null; }
    return { accounts, factory };
  }
  const by = req => req.user.name || req.user.username;

  function loomView(db, loom) {
    const st = h.loomState(db, loom);
    const warp = db.warps.find(w => w.id === loom.warpId), bobbin = db.bobbins.find(b => b.id === loom.bobbinId);
    const item = x => x ? { id: x.id, name: x.name, remainingMeters: x.remainingMeters, originalMeters: x.originalMeters, sareesLeft: sareesLeft(x),
      colour: x.color != null ? x.color : `${x.bodyColor} / ${x.borderColor}`, hex: x.colorHex || x.bodyHex || null, hex2: x.colorHex || x.borderHex || null } : null;
    const today = dayKey(Date.now()), weekAgo = Date.now() - 7 * 864e5;
    const mine = db.deliveries.filter(d => d.loomId === loom.id);
    const design = db.designs.find(d => d.id === loom.designId);
    return {
      id: loom.id, name: loom.name, widthType: loom.widthType, needsBobbin: !!loom.needsBobbin, running: st.running, reason: st.reason,
      jobOrderId: loom.jobOrderId || null, designId: loom.designId || null, designNo: design ? design.number : "",
      warp: item(warp), bobbin: item(bobbin),
      today: mine.filter(d => dayKey(d.createdAt) === today).reduce((s, d) => s + d.sarees, 0),
      week: mine.filter(d => new Date(d.createdAt).getTime() >= weekAgo).reduce((s, d) => s + d.sarees, 0)
    };
  }

  function factoryView(accounts, factory, partyId) {
    const db = h.readDb(factory.id);
    const looms = db.looms.filter(l => l.partyId === partyId);
    const loomIds = new Set(looms.map(l => l.id));
    const active = x => x.status !== "Completed" && x.status !== "Discarded";
    const itemOf = x => ({ id: x.id, name: x.name, widthType: x.widthType, status: x.status, remainingMeters: x.remainingMeters, originalMeters: x.originalMeters,
      sareesLeft: sareesLeft(x), loomId: x.assignedLoomId || null, forLoomId: x.forLoomId || null, colour: x.color != null ? x.color : `${x.bodyColor} / ${x.borderColor}`,
      hex: x.colorHex || x.bodyHex || null, hex2: x.colorHex || x.borderHex || null });
    const ofParty = x => x.partyId === partyId || loomIds.has(x.assignedLoomId);
    return {
      id: factory.id, name: factory.name, location: factory.location || "", ownerName: factory.ownerName || "", ownerPhone: factory.ownerPhone || "",
      perms: permsFor(factory, partyId),
      owners: accounts.users.filter(u => u.role === "user" && (u.factoryIds || []).includes(factory.id)).map(u => ({ username: u.username, name: u.name || "" })),
      looms: looms.map(l => loomView(db, l)),
      warps: db.warps.filter(w => active(w) && ofParty(w)).map(itemOf),
      bobbins: db.bobbins.filter(b => active(b) && ofParty(b)).map(itemOf),
      designs: db.designs.filter(d => d.partyId === partyId).map(({ image, ...d }) => ({ ...d, hasImage: !!image })),
      jobOrders: (db.jobOrders || []).filter(j => j.partyId === partyId).map(j => ({ ...j, ...jobStats(db, j) })),
      requests: (db.requests || []).filter(r => r.partyId === partyId),
      shipments: (db.shipments || []).filter(s => s.partyId === partyId),
      announcements: (db.announcements || []).filter(a => a.partyId === partyId),
      feed: db.activity.filter(a => a.partyId === partyId).slice(0, 60).map(a => ({ ...a, factoryId: factory.id, factoryName: factory.name }))
    };
  }

  router.get("/overview", (req, res) => {
    const accounts = store.readAccounts();
    const factories = store.partyFactories(accounts, req.party.id).map(f => factoryView(accounts, f, req.party.id));
    res.json({ party: req.party, factories });
  });

  // ---- Factories and their owners ----
  // Registers a factory for this party and gives its owner a login. An existing owner login (role user)
  // can be linked instead of creating one: send its username without a password.
  router.post("/factories", (req, res) => {
    const b = req.body || {};
    const name = text(b.name), location = text(b.location), ownerName = text(b.ownerName), ownerPhone = text(b.ownerPhone);
    const username = text(b.username), password = String(b.password || "");
    if (!name || !ownerName) return res.status(400).json({ error: "Enter the factory name and the owner's name." });
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) return res.status(400).json({ error: "Owner login: 3–32 letters, numbers, dots, dashes or underscores (the mobile number works well)." });
    const accounts = store.readAccounts();
    if (accounts.factories.some(f => f.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: "A factory with this name already exists. Ask the admin to link it to you." });
    let owner = accounts.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (owner && owner.role !== "user") return res.status(409).json({ error: "That login belongs to another kind of account. Choose another login." });
    if (!owner && password.length < 4) return res.status(400).json({ error: "Set a password of at least 4 characters for the owner." });
    const now = new Date().toISOString();
    const factory = { id: store.newId("FAC"), name, location, ownerName, ownerPhone, ownerEmail: "", partyIds: [req.party.id], createdByParty: req.party.id, createdAt: now };
    store.writeFactoryRaw(factory.id, store.emptyFactoryData());
    accounts.factories.push(factory);
    if (owner) owner.factoryIds = [...new Set([...(owner.factoryIds || []), factory.id])];
    else {
      owner = { id: store.newId("USR"), username, name: ownerName, role: "user", factoryIds: [factory.id], ...store.hashPassword(password), tokenVersion: 0, createdAt: now };
      accounts.users.push(owner);
    }
    store.writeAccounts(accounts);
    res.status(201).json({ factory, owner: store.publicUser(owner) });
  });

  // What the owner may do on this party's looms: { perms: { dispatch, stop, warp, receive, request, ship } }.
  router.put("/factories/:fid/perms", (req, res) => {
    const o = own(req, res); if (!o) return;
    const raw = req.body?.perms || {};
    const perms = Object.fromEntries(PERM_KEYS.map(k => [k, raw[k] === undefined ? permsFor(o.factory, req.party.id)[k] : raw[k] === true]));
    o.factory.ownerPerms = { ...(o.factory.ownerPerms || {}), [req.party.id]: perms };
    store.writeAccounts(o.accounts);
    const db = h.readDb(o.factory.id);
    h.logEvent(db, req, "notice", `${req.party.name} changed what the owner may do: ${PERM_KEYS.map(k => `${k} ${perms[k] ? "on" : "off"}`).join(", ")}`, req.party.id);
    h.writeDb(o.factory.id, db);
    res.json({ perms });
  });

  // ---- Looms ----
  const loomFields = b => ({ name: text(b.name), widthType: b.widthType, needsBobbin: b.needsBobbin === true });
  router.post("/factories/:fid/looms", (req, res) => {
    const o = own(req, res); if (!o) return;
    const f = loomFields(req.body || {});
    if (!f.name || !["single", "triple"].includes(f.widthType)) return res.status(400).json({ error: "Enter loom number and width type." });
    const db = h.readDb(o.factory.id);
    if (db.looms.some(l => l.name.toLowerCase() === f.name.toLowerCase())) return res.status(409).json({ error: "A loom with this number/name already exists in this factory." });
    const loom = { id: h.newId("LOOM"), ...f, plan: "", bodyColor: "", borderColor: "", plannedMeters: null, wovenMeters: 0, warpId: null,
      status: "Available", partyId: req.party.id, createdAt: new Date().toISOString() };
    db.looms.unshift(loom);
    h.logEvent(db, req, "loom", `Loom ${f.name} added by ${req.party.name} · ${f.widthType} width · ${f.needsBobbin ? "warp + bobbin" : "warp only"}`, req.party.id);
    h.writeDb(o.factory.id, db);
    res.status(201).json(loom);
  });

  router.put("/factories/:fid/looms/:lid", (req, res) => {
    const o = own(req, res); if (!o) return;
    const f = loomFields(req.body || {});
    const db = h.readDb(o.factory.id);
    const loom = db.looms.find(l => l.id === req.params.lid && l.partyId === req.party.id);
    if (!loom) return res.status(404).json({ error: "Loom not found." });
    if (!f.name || !["single", "triple"].includes(f.widthType)) return res.status(400).json({ error: "Enter loom number and width type." });
    if (db.looms.some(l => l !== loom && l.name.toLowerCase() === f.name.toLowerCase())) return res.status(409).json({ error: "A loom with this number/name already exists in this factory." });
    if (f.widthType !== loom.widthType && (loom.warpId || loom.bobbinId)) return res.status(409).json({ error: "The factory must take the warp and bobbin off this loom before its width changes." });
    if (!f.needsBobbin && loom.bobbinId) return res.status(409).json({ error: "The factory must take the bobbin off before this loom runs on warp only." });
    const old = loom.name;
    Object.assign(loom, f);
    h.logEvent(db, req, "loom", `Loom ${old} updated by ${req.party.name} · ${f.name}, ${f.widthType} width, ${f.needsBobbin ? "warp + bobbin" : "warp only"}`, req.party.id);
    h.writeDb(o.factory.id, db);
    res.json(loom);
  });

  // ---- Designs ---- (the owner sets the weaver's wage per saree; the party sets number, name and its job rate)
  const designFields = b => {
    const jobRate = b.jobRate === "" || b.jobRate == null ? null : Number(b.jobRate);
    return { number: text(b.number), name: text(b.name), jobRate: Number.isFinite(jobRate) && jobRate >= 0 ? Math.round(jobRate * 100) / 100 : jobRate === null ? null : NaN };
  };
  router.post("/factories/:fid/designs", (req, res) => {
    const o = own(req, res); if (!o) return;
    const f = designFields(req.body || {});
    if (!f.number) return res.status(400).json({ error: "Enter the design number." });
    if (Number.isNaN(f.jobRate)) return res.status(400).json({ error: "Job rate must be a number (0 or more)." });
    const db = h.readDb(o.factory.id);
    if (db.designs.some(d => d.number.toLowerCase() === f.number.toLowerCase())) return res.status(409).json({ error: "A design with this number already exists in this factory." });
    const design = { id: h.newId("DSN"), ...f, rate: 0, picks: null, timing: null, pickCost: null, image: null, imageAt: null, partyId: req.party.id, createdAt: new Date().toISOString() };
    db.designs.unshift(design);
    h.logEvent(db, req, "wages", `Design ${f.number}${f.name ? ` (${f.name})` : ""} added by ${req.party.name}`, req.party.id);
    h.writeDb(o.factory.id, db);
    const { image, ...rest } = design;
    res.status(201).json({ ...rest, hasImage: false });
  });

  router.put("/factories/:fid/designs/:did", (req, res) => {
    const o = own(req, res); if (!o) return;
    const f = designFields(req.body || {});
    if (!f.number) return res.status(400).json({ error: "Enter the design number." });
    if (Number.isNaN(f.jobRate)) return res.status(400).json({ error: "Job rate must be a number (0 or more)." });
    const db = h.readDb(o.factory.id);
    const design = db.designs.find(d => d.id === req.params.did && d.partyId === req.party.id);
    if (!design) return res.status(404).json({ error: "Design not found." });
    if (db.designs.some(d => d !== design && d.number.toLowerCase() === f.number.toLowerCase())) return res.status(409).json({ error: "A design with this number already exists in this factory." });
    Object.assign(design, f);
    h.logEvent(db, req, "wages", `Design ${f.number} updated by ${req.party.name}`, req.party.id);
    h.writeDb(o.factory.id, db);
    const { image, ...rest } = design;
    res.json({ ...rest, hasImage: !!image });
  });

  // ---- Job orders ----
  function setJobLooms(db, jo, loomIds) {
    for (const l of db.looms) if (l.jobOrderId === jo.id && !loomIds.includes(l.id)) delete l.jobOrderId;
    for (const lid of loomIds) {
      const l = db.looms.find(x => x.id === lid);
      l.jobOrderId = jo.id;
      if (jo.designId) {
        l.designId = jo.designId;
        if (l.designIds?.length && !l.designIds.includes(jo.designId)) l.designIds.push(jo.designId);
      }
    }
    jo.loomIds = loomIds;
  }
  function jobInput(req, db, partial) {
    const b = req.body || {};
    const out = {};
    if (!partial || b.target !== undefined) {
      out.target = posInt(b.target);
      if (!out.target) return { error: "Enter how many sarees this job order is for." };
    }
    if (!partial || b.loomIds !== undefined) {
      const ids = [...new Set(Array.isArray(b.loomIds) ? b.loomIds.map(text).filter(Boolean) : [])];
      const looms = ids.map(i => db.looms.find(l => l.id === i && l.partyId === req.party.id));
      if (looms.some(l => !l)) return { error: "Pick looms you set up in this factory." };
      const widths = new Set(looms.map(l => l.widthType));
      if (widths.size > 1) return { error: "A job order's looms must all be the same width." };
      out.loomIds = ids;
      if (looms[0]) out.widthType = looms[0].widthType;
    }
    if (!partial || b.designId !== undefined) {
      const designId = text(b.designId);
      const design = designId ? db.designs.find(d => d.id === designId) : null;
      if (designId && !design) return { error: "Design not found." };
      Object.assign(out, { designId: design ? design.id : null, designNo: design ? design.number : "", designName: design ? design.name || "" : "" });
    }
    if (b.note !== undefined || !partial) out.note = text(b.note);
    return out;
  }
  router.post("/factories/:fid/job-orders", (req, res) => {
    const o = own(req, res); if (!o) return;
    const db = h.readDb(o.factory.id);
    const v = jobInput(req, db, false);
    if (v.error) return res.status(400).json({ error: v.error });
    db.jobSeq = (db.jobSeq || 0) + 1;
    const jo = { id: h.newId("JWO"), code: `JWO-${String(db.jobSeq).padStart(4, "0")}`, partyId: req.party.id, widthType: v.widthType || null,
      designId: v.designId, designNo: v.designNo, designName: v.designName, target: v.target, note: v.note, loomIds: [], status: "open", createdAt: new Date().toISOString() };
    setJobLooms(db, jo, v.loomIds);
    db.jobOrders.unshift(jo);
    const loomNames = v.loomIds.map(i => db.looms.find(l => l.id === i).name).join(", ");
    h.logEvent(db, req, "notice", `Job order ${jo.code} from ${req.party.name} · ${jo.target} sarees${jo.designNo ? ` · ${jo.designNo}` : ""}${loomNames ? ` · on ${loomNames}` : ""}`, req.party.id);
    h.writeDb(o.factory.id, db);
    res.status(201).json({ ...jo, ...jobStats(db, jo) });
  });

  router.put("/factories/:fid/job-orders/:jid", (req, res) => {
    const o = own(req, res); if (!o) return;
    const db = h.readDb(o.factory.id);
    const jo = db.jobOrders.find(j => j.id === req.params.jid && j.partyId === req.party.id);
    if (!jo) return res.status(404).json({ error: "Job order not found." });
    const v = jobInput(req, db, true);
    if (v.error) return res.status(400).json({ error: v.error });
    const status = req.body?.status;
    if (status !== undefined && !["open", "closed"].includes(status)) return res.status(400).json({ error: "Status must be open or closed." });
    const { loomIds, ...rest } = v;
    Object.assign(jo, rest);
    if (status) jo.status = status;
    setJobLooms(db, jo, jo.status === "closed" ? [] : loomIds || jo.loomIds);
    h.logEvent(db, req, "notice", `Job order ${jo.code} updated by ${req.party.name} · ${jo.target} sarees${jo.status === "closed" ? " · closed" : ""}`, req.party.id);
    h.writeDb(o.factory.id, db);
    res.json({ ...jo, ...jobStats(db, jo) });
  });

  // ---- Warp / weft requests from the factory owner ----
  // Approving puts a new warp (or bobbin) on the factory's board as Ordered, tagged with this party and the loom it is for.
  //   { approve: true, sarees?, name?, bodyColor?, borderColor?, color? } | { approve: false, reason? }
  router.post("/factories/:fid/requests/:rid/decide", (req, res) => {
    const o = own(req, res); if (!o) return;
    const b = req.body || {};
    const db = h.readDb(o.factory.id);
    const r = db.requests.find(x => x.id === req.params.rid && x.partyId === req.party.id);
    if (!r) return res.status(404).json({ error: "Request not found." });
    if (r.status !== "pending") return res.status(409).json({ error: `This request is already ${r.status}.` });
    const noun = r.kind === "bobbin" ? "weft" : "warp";
    const now = new Date().toISOString();
    if (b.approve !== true) {
      Object.assign(r, { status: "rejected", reason: text(b.reason), decidedBy: by(req), decidedAt: now });
      h.logEvent(db, req, "request", `${req.party.name} rejected the ${noun} request for ${r.loomName}${r.reason ? ` · ${r.reason}` : ""}`, req.party.id);
      h.writeDb(o.factory.id, db);
      return res.json(r);
    }
    const sarees = b.sarees == null || b.sarees === "" ? r.sarees : posInt(b.sarees);
    if (!sarees) return res.status(400).json({ error: "Enter the number of sarees as a whole number." });
    if (r.widthType === "triple" && sarees % 3) return res.status(400).json({ error: "For a triple-width loom, enter sarees in multiples of 3." });
    const meters = metersFor(sarees, r.widthType);
    const coll = r.kind === "bobbin" ? db.bobbins : db.warps;
    const loom = db.looms.find(l => l.id === r.loomId);
    const current = loom && coll.find(x => x.id === (r.kind === "bobbin" ? loom.bobbinId : loom.warpId));
    let name = text(b.name) || `${r.kind === "bobbin" ? "B" : "W"}-${r.id.slice(-4)}`;
    if (coll.some(x => x.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: `A ${noun} called ${name} already exists in this factory. Give it another name.` });
    const base = { id: h.newId(r.kind === "bobbin" ? "BOB" : "WARP"), name, widthType: r.widthType, originalMeters: meters, remainingMeters: meters,
      orderDate: now.slice(0, 10), status: "Ordered", assignedLoomId: null, partyId: req.party.id, forLoomId: r.loomId, requestId: r.id, createdAt: now };
    const item = r.kind === "bobbin"
      ? { ...base, color: text(b.color) || current?.color || "As before", colorHex: current?.colorHex || null }
      : { ...base, bodyColor: text(b.bodyColor) || current?.bodyColor || "As before", borderColor: text(b.borderColor) || current?.borderColor || "As before",
          bodyHex: current?.bodyHex || null, borderHex: current?.borderHex || null };
    coll.unshift(item);
    Object.assign(r, { status: "approved", sarees, meters, decidedBy: by(req), decidedAt: now, itemId: item.id, itemName: item.name });
    h.logEvent(db, req, "request", `${req.party.name} approved ${noun} ${item.name} for ${r.loomName} · ${sarees} sarees (${meters} m), on order`, req.party.id);
    h.writeDb(o.factory.id, db);
    res.json({ request: r, item });
  });

  // ---- Shipments: the party confirms what arrived ----  { issue? }
  router.post("/factories/:fid/shipments/:sid/receive", (req, res) => {
    const o = own(req, res); if (!o) return;
    const db = h.readDb(o.factory.id);
    const s = db.shipments.find(x => x.id === req.params.sid && x.partyId === req.party.id);
    if (!s) return res.status(404).json({ error: "Delivery not found." });
    if (s.receivedAt) return res.status(409).json({ error: "This delivery is already confirmed." });
    Object.assign(s, { receivedAt: new Date().toISOString(), receivedBy: by(req), issue: text(req.body?.issue) });
    h.logEvent(db, req, "shipment", `${req.party.name} received ${s.qty} sarees (${s.jobCode}${s.lrNumber ? `, LR ${s.lrNumber}` : ""})${s.issue ? ` · issue: ${s.issue}` : ""}`, req.party.id);
    h.writeDb(o.factory.id, db);
    res.json(s);
  });

  // ---- Announcements to factory owners ----  { factoryIds, kind, title, body, ackRequired }
  router.post("/announcements", (req, res) => {
    const b = req.body || {};
    const title = text(b.title), body = text(b.body);
    const kind = ["warp", "design", "holiday", "general"].includes(b.kind) ? b.kind : "general";
    if (!title) return res.status(400).json({ error: "Enter a title." });
    const accounts = store.readAccounts();
    const mine = store.partyFactories(accounts, req.party.id);
    const ids = [...new Set(Array.isArray(b.factoryIds) ? b.factoryIds : [])];
    const targets = ids.map(i => mine.find(f => f.id === i));
    if (!targets.length || targets.some(f => !f)) return res.status(400).json({ error: "Pick at least one of your factories." });
    const out = [];
    for (const f of targets) {
      const db = h.readDb(f.id);
      const a = { id: h.newId("ANN"), partyId: req.party.id, partyName: req.party.name, kind, title, body, ackRequired: b.ackRequired !== false, acks: [], by: by(req), createdAt: new Date().toISOString() };
      db.announcements.unshift(a);
      h.logEvent(db, req, "notice", `Announcement from ${req.party.name}: ${title}`, req.party.id);
      h.writeDb(f.id, db);
      out.push({ factoryId: f.id, ...a });
    }
    res.status(201).json({ sent: out });
  });

  return router;
};

module.exports.jobStats = jobStats;
module.exports.permsFor = permsFor;
module.exports.partyManaged = partyManaged;
module.exports.metersFor = metersFor;
module.exports.DEFAULT_PERMS = DEFAULT_PERMS;
module.exports.perMeter = perMeter;
