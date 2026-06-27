// fixtures/ssrf/server.mjs — bundled mock scrape endpoints for the ssrf check.
//
// Two modes model the control and its absence so the check is PROVABLE offline:
//
//   good — an SSRF-safe scraper. POST / {url}: classifies the target host with
//          the SAME predicate the real check expects (classifyHost from
//          checks/ssrf.mjs). Internal host -> 403 {blocked:true}. External host
//          -> 200 {ok:true}. The negative control should judge this `pass`.
//
//   bad  — an SSRF sink. POST / {url}: ALWAYS 200 {ok:true}, no guard at all.
//          It will "fetch" 127.0.0.1 / 169.254.169.254 on request. The negative
//          control should judge this `fail` — that is the detector firing.
//
// Both listen on 127.0.0.1 with an EPHEMERAL port (listen on 0, read the
// assigned port) so nothing collides and no fixed port leaks into the repo.
//
// Node 22 built-ins only (node:http). No npm deps.

import http from "node:http";
import { classifyHost } from "../../checks/ssrf.mjs";

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1 << 20) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

function handler(mode) {
  return async (req, res) => {
    if (req.method !== "POST") return send(res, 405, { error: "POST only" });
    const body = await readJsonBody(req);
    if (!body || typeof body.url !== "string") {
      return send(res, 400, { error: "expected JSON {url}" });
    }

    if (mode === "bad") {
      // No SSRF guard whatsoever — fetches anything it is told to.
      return send(res, 200, { ok: true, fetched: body.url });
    }

    // good: refuse internal targets.
    let host;
    try { host = new URL(body.url).hostname; }
    catch { return send(res, 400, { error: "unparseable url" }); }
    const verdict = await classifyHost(host);
    if (verdict.internal) {
      return send(res, 403, { blocked: true, reason: verdict.why, target: body.url });
    }
    return send(res, 200, { ok: true, fetched: body.url });
  };
}

// Start a mock. Returns { url, port, server, close() }.
export function startMock(mode) {
  if (mode !== "good" && mode !== "bad") {
    return Promise.reject(new Error(`mode must be "good" or "bad", got ${mode}`));
  }
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler(mode));
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const url = `http://127.0.0.1:${port}/`;
      resolve({
        url,
        port,
        server,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// CLI: `node server.mjs good|bad` — start the mock, print its URL, stay alive
// (for manual probing with `node ../../checks/ssrf.mjs --target <url>`).
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2];
  startMock(mode).then((m) => {
    process.stdout.write(`URL=${m.url}\n`);
    process.stdout.write(`mode=${mode} pid=${process.pid} — POST / {url}; Ctrl-C to stop\n`);
    const stop = () => m.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }).catch((e) => { process.stderr.write(`failed to start ${mode} mock: ${e.message}\n`); process.exit(1); });
}
