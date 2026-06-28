// _proxy.mjs — the thin LiteLLM HTTP client.
//
// This is the ONLY file that talks to the network. It exposes the same
// `callModel(model, prompt)` contract that _chain.mjs consumes, so in production
// the chain is fed this, and in self-test it is fed makeFixtureCallModel — same
// orchestration, swapped transport.
//
// SECRETS DISCIPLINE: the proxy URL and key are read from the host environment
// ONLY ($LITELLM_BASE_URL / $LITELLM_API_KEY). The key is NEVER written to a
// file, NEVER logged, NEVER echoed into output. The prompt is likewise never
// logged here.
//
// HONEST FAILURE: any transport failure (no key/URL configured, network error,
// non-2xx, non-JSON body) returns a { __unreachable: true, error } SENTINEL —
// it does NOT throw and does NOT fabricate a response. _chain.parseModelResponse
// maps that sentinel (and any malformed body) to "did not respond", which the
// honest-corroboration rule turns into `unknown` rather than a fake answer.

const ENV_BASE = "LITELLM_BASE_URL";
const ENV_KEY = "LITELLM_API_KEY";

export function proxyConfigured(env = process.env) {
  return Boolean(env[ENV_BASE] && env[ENV_KEY]);
}

// Build the live callModel. Reads URL + key from env at call time. Returns the
// parsed JSON body (OpenAI chat-completions shape) on success, or the
// __unreachable sentinel on any failure.
export function makeProxyCallModel(opts = {}) {
  const env = opts.env || process.env;
  const timeoutMs = opts.timeoutMs ?? 60000;

  return async function callModel(model, prompt) {
    const base = env[ENV_BASE];
    const key = env[ENV_KEY];
    if (!base || !key) {
      // No live proxy configured — honest unreachable, never a silent answer.
      return { __unreachable: true, error: `proxy not configured ($${ENV_BASE}/$${ENV_KEY} unset)` };
    }
    const url = base.replace(/\/+$/, "") + "/chat/completions";
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The key goes in the Authorization header only — never logged below.
          "authorization": `Bearer ${key}`,
        },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
        signal: ac.signal,
      });
      if (!resp.ok) {
        // Note: we deliberately do NOT include the response body, which could
        // echo request context. Status code only.
        return { __unreachable: true, error: `proxy HTTP ${resp.status} for model ${model}` };
      }
      let body;
      try { body = await resp.json(); }
      catch { return { __unreachable: true, error: `proxy returned non-JSON body for model ${model}` }; }
      return body; // parseModelResponse validates choices[0].message.content
    } catch (e) {
      const reason = e?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : (e?.message || "network error");
      return { __unreachable: true, error: `proxy call failed for model ${model}: ${reason}` };
    } finally {
      clearTimeout(timer);
    }
  };
}
