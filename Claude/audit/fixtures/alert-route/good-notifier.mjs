// fixtures/alert-route/good-notifier.mjs — POSITIVE-control notifier.
//
// A mock channel that genuinely delivers: send_alert() returns delivered:true
// with status "delivered". The alert-route self-guard requires this to judge
// `pass` — it proves the check recognises a real delivery (guards against a
// check that can only ever say unknown/fail).
//
// Node 22 built-ins only. No npm deps.
export async function send_alert(event) {
  return {
    delivered: true,
    status: "delivered",
    channel: "mock",
    note: "mock delivered",
    event,
  };
}
