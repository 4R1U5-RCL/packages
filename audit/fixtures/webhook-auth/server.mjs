// fixtures/webhook-auth/server.mjs — LOCAL mock webhook receivers.
//
// Two receivers, both bound to 127.0.0.1 on an EPHEMERAL port (listen 0), so
// the webhook-auth check is provable OFFLINE with zero npm deps and no real
// infrastructure:
//
//   GOOD receiver  — the SECURE behaviour we want production to have. Reads the
//                    raw body and the signature header, recomputes
//                    HMAC-SHA256(rawBody) under a shared FAKE secret, compares
//                    with crypto.timingSafeEqual, and (optionally) rejects a
//                    stale/missing timestamp. 200 only on a correct signature
//                    inside the replay window; 401 otherwise.
//   BAD  receiver  — the VULNERABLE behaviour (the TE-16 class): 200 for every
//                    request, signature ignored. No inbound authentication.
//
// The secret here is FAKE on purpose (WORKING_METHOD: never a real credential in
// a fixture). It exists only so good/bad receivers and the check agree on a key.
//
// Used two ways:
//   - imported by checks/webhook-auth.mjs for the in-process self-guard, and
//   - run as a CLI to start a long-lived receiver for manual proof:
//       node server.mjs --mode good   # prints {"url":"http://127.0.0.1:PORT/webhook"}
//       node server.mjs --mode bad

import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

// Shared FAKE secret — NOT a real credential. Mirrors manifests/webhook-auth.json.
export const FAKE_SECRET = "test-secret-not-real";
// n8n's inbound HMAC header. Configurable in the manifest; this is the default.
export const SIG_HEADER = "x-n8n-signature";
export const TS_HEADER = "x-n8n-timestamp";
// Generous default replay window (seconds) so a fresh, correctly-signed payload
// is never rejected for timing; staleness is a secondary control here.
export const DEFAULT_WINDOW = 300;

export function sign(secret, rawBody) {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.alloc(0)));
  });
}

function deny(res, msg) {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: msg }));
}

// GOOD receiver: HMAC-SHA256 over the raw body, constant-time compare, optional
// replay window. This is the reference for "inbound webhook is authenticated".
function goodHandler({ secret = FAKE_SECRET, window = DEFAULT_WINDOW } = {}) {
  return async (req, res) => {
    const raw = await readRawBody(req);
    const sig = req.headers[SIG_HEADER];
    if (!sig) return deny(res, "missing signature");
    const expected = sign(secret, raw);
    const a = Buffer.from(String(sig), "utf8");
    const b = Buffer.from(expected, "utf8");
    // length check first: timingSafeEqual throws on unequal-length buffers.
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return deny(res, "bad signature");
    }
    // Optional replay/timestamp window. Only enforced when a timestamp header is
    // present; a fresh, correctly-signed payload from the check carries one.
    if (window && window > 0) {
      const ts = Number(req.headers[TS_HEADER]);
      if (Number.isFinite(ts) && Math.abs(Date.now() / 1000 - ts) > window) {
        return deny(res, "stale timestamp (replay window exceeded)");
      }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  };
}

// BAD receiver: accepts everything. The known-vulnerable target the check must
// flag (status=fail) — the negative control for the self-guard.
function badHandler() {
  return (req, res) => {
    // Drain the body so the socket closes cleanly, then 200 regardless.
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, note: "no auth — accepts anything" }));
    });
  };
}

function start(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}/webhook`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

export function startGoodReceiver(opts = {}) {
  return start(goodHandler(opts));
}

export function startBadReceiver() {
  return start(badHandler());
}

// CLI: start one long-lived receiver and print its URL as JSON, then stay up.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const flag = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
  };
  const mode = flag("mode", "good");
  const secret = flag("secret", FAKE_SECRET);
  const window = Number(flag("window", DEFAULT_WINDOW));
  const starter =
    mode === "bad"
      ? startBadReceiver()
      : startGoodReceiver({ secret, window });
  starter.then((rcv) => {
    process.stdout.write(
      JSON.stringify({ mode, url: rcv.url, port: rcv.port, secret }) + "\n"
    );
    // Keep the process alive until killed.
  });
}
