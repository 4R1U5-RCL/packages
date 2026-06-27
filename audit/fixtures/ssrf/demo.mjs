// fixtures/ssrf/demo.mjs — convenience proof harness.
//
// Starts the good|bad mock on an ephemeral 127.0.0.1 port, points the REAL
// check (checks/ssrf.mjs run path) at it, emits the result through the one
// output contract, and exits with the check's exit code (0 pass / 1 fail /
// 2 unknown). This is exactly `node ssrf.mjs --target <mockUrl>` with the mock
// started for you.
//
//   node demo.mjs good   -> expect status pass, exit 0
//   node demo.mjs bad    -> expect status fail, exit 1

import { startMock } from "./server.mjs";
import { Result, emitResult } from "../../checks/_common.mjs";
import { selfGuard, classifyEndpoint } from "../../checks/ssrf.mjs";

const mode = process.argv[2];
if (mode !== "good" && mode !== "bad") {
  process.stderr.write("usage: node demo.mjs good|bad\n");
  process.exit(64);
}

const mock = await startMock(mode);
try {
  const r = new Result("ssrf", "infra");
  const sg = await selfGuard();
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (!sg.ok) {
    r.set("unknown", { evidence: sg.note, message: "SSRF self-guard failed" });
  } else {
    const v = await classifyEndpoint(mock.url);
    r.set(v.status, {
      evidence: `[demo ${mode} mock ${mock.url}] ${v.evidence}. Self-guard: ${sg.note}`,
      message: v.message,
    });
  }
  const code = emitResult(r);
  await mock.close();
  process.exit(code);
} catch (e) {
  await mock.close();
  process.stderr.write(`demo error: ${e.message}\n`);
  process.exit(2);
}
