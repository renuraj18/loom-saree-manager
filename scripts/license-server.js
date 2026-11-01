// Vendor tool: a minimal license check-in server (no dependencies). Installs whose license has a checkinUrl
// POST { licenseId, installId, version, edition, usage } to it about once a week.
//   node scripts/license-server.js [--port 8787] [--revoked revoked.json] [--log checkins.jsonl]
// revoked.json: { "LIC-ABC123": "Payment pending. Call 98400…" } — those installs turn read-only on their next check-in;
// remove the entry and they recover on the following one. Run it behind HTTPS (e.g. a Cloudflare Tunnel).
const http = require("http");
const fs = require("fs");
const args = Object.fromEntries(process.argv.slice(2).join(" ").split("--").filter(Boolean).map(s => s.trim().split(/\s+/)));
const port = Number(args.port || 8787), revokedFile = args.revoked || "revoked.json", logFile = args.log || "checkins.jsonl";
http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.method !== "POST" || !req.url.startsWith("/checkin")) return send(404, { error: "Not found" });
  let raw = "";
  req.on("data", c => { raw += c; if (raw.length > 1e5) req.destroy(); });
  req.on("end", () => {
    let b; try { b = JSON.parse(raw); } catch { return send(400, { error: "Bad request" }); }
    let revoked = {}; try { revoked = JSON.parse(fs.readFileSync(revokedFile, "utf8")); } catch { /* none */ }
    fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ip: req.socket.remoteAddress, ...b }) + "\n");
    const msg = revoked[b.licenseId];
    send(200, msg ? { revoked: true, message: String(msg) } : { ok: true });
  });
}).listen(port, () => console.log(`License check-in server on :${port} (revoked list: ${revokedFile})`));
