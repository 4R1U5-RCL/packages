// TEST FIXTURE (secret-leak / bad) — INJECTED NEGATIVE CONTROL.
// The string below is an OBVIOUSLY FAKE, NON-FUNCTIONAL placeholder (literal
// "FAKE" + repeated zeros) that matches the openai-litellm `sk-` pattern. It is
// test data only — it authenticates against nothing. The secret scan MUST flag
// this line; that firing is the negative control for this check.
const KEY = "sk-FAKE000000000000000000000000000";

export const config = {
  apiKey: KEY,
  region: "us-east-1",
};
