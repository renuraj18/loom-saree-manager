// Vendor tool: issues a license key for one PC.
//   node scripts/issue-license.js --key ~/.mythari/license-private.pem --edition party|factory \
//     --licensee "Sri Lakshmi Silks" --install INS-XXXX-XXXX-XXXX --factories 5 --looms 60 \
//     (--days 365 | --until 2027-10-31) [--phone 98400…] [--checkin https://license.yourdomain.in/checkin]
// The customer finds the install ID in Settings → License and pastes the printed key there.
// Every key issued is appended to licenses-issued.csv next to the private key.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { sign } = require("../license");

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) { const next = process.argv[i + 1]; args[a.slice(2)] = next && !next.startsWith("--") ? (i++, next) : true; }
}
const fail = m => { console.error(m); process.exit(1); };
if (!args.key) fail("--key <private key file> is required");
if (!["party", "factory"].includes(args.edition)) fail("--edition must be party or factory");
if (!args.licensee) fail("--licensee is required");
if (!/^INS-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(args.install || "")) fail("--install must be the install ID shown in Settings → License (INS-XXXX-XXXX-XXXX)");
const maxFactories = Number(args.factories ?? (args.edition === "factory" ? 1 : NaN));
const maxLooms = Number(args.looms);
if (!(Number.isInteger(maxFactories) && maxFactories > 0)) fail("--factories must be a whole number above 0");
if (!(Number.isInteger(maxLooms) && maxLooms > 0)) fail("--looms must be a whole number above 0");
let expiresAt = args.until;
if (!expiresAt) {
  const days = Number(args.days || 365);
  const d = new Date(Date.now() + days * 864e5);
  expiresAt = d.toISOString().slice(0, 10);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) fail("--until must be YYYY-MM-DD");
const payload = {
  v: 1, id: "LIC-" + crypto.randomBytes(5).toString("hex").toUpperCase(), edition: args.edition, licensee: String(args.licensee),
  ...(args.phone ? { phone: String(args.phone) } : {}), installId: args.install, maxFactories, maxLooms,
  issuedAt: new Date().toISOString(), expiresAt, ...(args.checkin ? { checkinUrl: String(args.checkin) } : {})
};
const key = sign(payload, fs.readFileSync(path.resolve(args.key), "utf8"));
const log = path.join(path.dirname(path.resolve(args.key)), "licenses-issued.csv");
if (!fs.existsSync(log)) fs.writeFileSync(log, "issuedAt,id,edition,licensee,installId,maxFactories,maxLooms,expiresAt,key\n");
const csv = v => `"${String(v).replace(/"/g, '""')}"`;
fs.appendFileSync(log, [payload.issuedAt, payload.id, payload.edition, payload.licensee, payload.installId, maxFactories, maxLooms, expiresAt, key].map(csv).join(",") + "\n");
console.log(`${payload.id} · ${payload.edition} · ${payload.licensee} · ${maxFactories} factor${maxFactories === 1 ? "y" : "ies"}, ${maxLooms} looms · until ${expiresAt}\n`);
console.log(key);
