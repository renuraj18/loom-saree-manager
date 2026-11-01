// Live updates. GET /api/events?token=… is a Server-Sent Events stream: every time a factory's data file is
// written, each connected page that may see that factory gets `data: {"factoryId":…}` and reloads what it shows.
// EventSource cannot send headers, so the session token comes in the query string (same token as the API).
const clients = new Set();

function emit(factoryId) {
  const msg = `data: ${JSON.stringify({ factoryId, at: Date.now() })}\n\n`;
  for (const c of clients) if (!c.ids || c.ids.has(factoryId)) {
    try { c.res.write(msg); } catch { clients.delete(c); }
  }
}

// userFromToken(token) -> user | null; factoryIdsFor(user) -> [ids], or null for "every factory" (admins).
function eventsRoute(userFromToken, factoryIdsFor) {
  return (req, res) => {
    const user = userFromToken(String(req.query.token || ""));
    if (!user) return res.status(401).json({ error: "Please sign in." });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 3000\n\n");
    const ids = factoryIdsFor(user);
    const client = { res, ids: ids ? new Set(ids) : null };
    clients.add(client);
    // A comment line every 25 s keeps proxies and phones from closing an idle connection.
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, 25000);
    req.on("close", () => { clearInterval(ping); clients.delete(client); });
  };
}

module.exports = { emit, eventsRoute, clientCount: () => clients.size };
