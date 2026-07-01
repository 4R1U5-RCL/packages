// fixtures/alert-route/bad-notifier.mjs — NEGATIVE-control notifier.
//
// A mock channel that is WIRED but fails to deliver: send_alert() returns
// delivered:false with status "error" (distinct from the stub's "not-wired").
// This is the injected violation the alert-route self-guard exercises — a wired
// channel that did not deliver is a real finding and MUST be judged `fail`,
// never unknown. It proves the check can tell a delivery failure (fail) apart
// from the not-wired stub (unknown).
//
// Node 22 built-ins only. No npm deps.
export async function send_alert(event) {
  return {
    delivered: false,
    status: "error",
    channel: null,
    note: "mock delivery failed",
    event,
  };
}
