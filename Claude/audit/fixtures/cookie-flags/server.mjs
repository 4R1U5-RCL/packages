// fixtures/cookie-flags/server.mjs — bundled mock app for the cookie-flags check.
//
// Models OWASP A07 (Identification and Authentication Failures) at the session
// cookie level, and its absence, so the check is PROVABLE offline. The app
// exposes a login endpoint that SETS a session cookie via `Set-Cookie`. Two
// modes:
//
//   good — sets the session cookie with all three hardening flags:
//          `Set-Cookie: sid=abc123; Path=/; HttpOnly; Secure; SameSite=Lax`.
//          The cookie-flags negative control should judge this `pass`.
//
//   bad  — sets the SAME session cookie with NO flags at all:
//          `Set-Cookie: sid=abc123; Path=/`. No HttpOnly, no Secure, no
//          SameSite. The negative control should judge this `fail` — that is
//          the detector firing (a flagless session cookie was injected and the
//          missing-flags detector caught it).
//
// Both listen on 127.0.0.1 with an EPHEMERAL port (listen on 0) so nothing
// collides and no fixed port leaks into the repo.
//
// Node 22 built-ins only (node:http). No npm deps.

import http from "node:http";

// The fixture's ground truth: the session cookie name and value both modes set.
const COOKIE_NAME = "sid";
const COOKIE_VALUE = "abc123";

function setCookie(mode) {
  if (mode === "bad") {
    // Flagless session cookie — no HttpOnly, no Secure, no SameSite.
    return `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/`;
  }
  // good: all three hardening flags present.
  return `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function handler(mode) {
  return (req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "GET only" }));
    }
    const path = (req.url || "").split("?")[0];
    if (path !== "/login") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "expected /login" }));
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": setCookie(mode),
    });
    res.end(JSON.stringify({ ok: true, loggedIn: true }));
  };
}

// Start a mock. Returns { url, port, server, close() }. `url` ends with "/" so
// the check builds `${url}login` (path is configurable via --path).
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

// The fixture's known session-cookie facts — the check imports these for its
// self-guard so the ground truth lives in exactly one place.
export const FIXTURE = {
  cookieName: "sid",     // the session cookie both modes set
  path: "/login",        // the endpoint that emits Set-Cookie
};

// CLI: `node server.mjs good|bad` — start the mock, print its URL, stay alive.
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2];
  startMock(mode).then((m) => {
    process.stdout.write(`URL=${m.url}\n`);
    process.stdout.write(`mode=${mode} pid=${process.pid} — GET /login sets ` +
      `Set-Cookie: sid=...; Ctrl-C to stop\n`);
    const stop = () => m.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }).catch((e) => { process.stderr.write(`failed to start ${mode} mock: ${e.message}\n`); process.exit(1); });
}
