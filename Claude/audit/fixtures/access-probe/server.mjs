// fixtures/access-probe/server.mjs — bundled mock app for the access-probe check.
//
// Models OWASP A01 (Broken Access Control / IDOR) and its absence so the check
// is PROVABLE offline. The app exposes per-user records by id, behind a bearer
// token. Two users exist:
//
//   token "tok-a" owns record "1"      token "tok-b" owns record "2"
//
//   good — enforces object-level ownership. GET /record/:id returns the record
//          only if the bearer token owns it; otherwise 403 {denied:true}. The
//          access-probe negative control should judge this `pass`.
//
//   bad  — an IDOR sink. GET /record/:id returns ANY record to ANY valid token,
//          with no ownership check at all. User A can read user B's record. The
//          negative control should judge this `fail` — that is the detector
//          firing (cross-user read injected and succeeded).
//
// Both listen on 127.0.0.1 with an EPHEMERAL port (listen on 0) so nothing
// collides and no fixed port leaks into the repo.
//
// Node 22 built-ins only (node:http). No npm deps.

import http from "node:http";

// The fixture's ground truth: which token owns which record, and the data.
const OWNER = { "1": "tok-a", "2": "tok-b" };
const DATA = {
  "1": { id: "1", owner: "tok-a", secret: "alice-private-data" },
  "2": { id: "2", owner: "tok-b", secret: "bob-private-data" },
};

function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function bearer(req) {
  const h = req.headers["authorization"] || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function handler(mode) {
  return (req, res) => {
    if (req.method !== "GET") return send(res, 405, { error: "GET only" });
    const m = (req.url || "").match(/^\/record\/([^/?]+)/);
    if (!m) return send(res, 404, { error: "expected /record/:id" });
    const id = m[1];

    const token = bearer(req);
    if (!token || !Object.values(OWNER).includes(token)) {
      // No valid session at all — both modes reject (this isn't the IDOR axis).
      return send(res, 401, { denied: true, reason: "missing/invalid bearer token" });
    }
    if (!DATA[id]) return send(res, 404, { error: "no such record" });

    if (mode === "bad") {
      // IDOR sink: any authenticated user gets any record. No ownership check.
      return send(res, 200, DATA[id]);
    }

    // good: enforce object-level ownership.
    if (OWNER[id] !== token) {
      return send(res, 403, { denied: true, reason: "not the owner of this record" });
    }
    return send(res, 200, DATA[id]);
  };
}

// Start a mock. Returns { url, port, server, close() }. `url` ends with "/" so
// the check builds `${url}record/${id}`.
export function startMock(mode) {
  if (mode !== "good" && mode !== "bad") {
    return Promise.reject(new Error(`mode must be "good" or "bad", got ${mode}`));
  }
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler(mode));
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/`,
        port,
        server,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// The fixture's known credentials/ids — the check imports these for its
// self-guard so the ground truth lives in exactly one place.
export const FIXTURE = {
  ownToken: "tok-a",   // user A
  ownId: "1",          // record A owns
  foreignToken: "tok-b",
  foreignId: "2",      // record B owns — A must NOT be able to read it
};

// CLI: `node server.mjs good|bad` — start the mock, print its URL, stay alive.
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2];
  startMock(mode).then((m) => {
    process.stdout.write(`URL=${m.url}\n`);
    process.stdout.write(`mode=${mode} pid=${process.pid} — GET /record/:id with ` +
      `Authorization: Bearer tok-a|tok-b; Ctrl-C to stop\n`);
    const stop = () => m.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }).catch((e) => { process.stderr.write(`failed to start ${mode} mock: ${e.message}\n`); process.exit(1); });
}
