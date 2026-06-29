// src/config.mjs — env resolution (CORE, no secrets in files).
//
// Resolves the three Stripe settings from the host environment first, then an
// OPTIONAL chmod-600 `~/.claude/stripe-billing.env` fallback for any key still
// unset. No secret is ever stored in this package — this only READS them.
// PURE-ish: pass `env` explicitly (the selftest does) to avoid touching the
// process environment or the filesystem.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const FALLBACK_FILE = join(homedir(), ".claude", "stripe-billing.env");

const KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRO_PRICE_ID"];

/** Parse a minimal dotenv file (KEY=value, `#` comments, optional quotes). */
export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Resolve config. `env` wins; the fallback file fills any still-unset key.
 *
 * @param {Record<string,string|undefined>} [env]  defaults to process.env
 * @param {string} [filePath]  fallback file (defaults to ~/.claude/stripe-billing.env)
 * @returns {{secretKey?:string, webhookSecret?:string, proPriceId?:string, missing:string[]}}
 */
export function loadConfig(env = process.env, filePath = FALLBACK_FILE) {
  const resolved = {};
  for (const k of KEYS) if (env[k]) resolved[k] = env[k];

  const needFile = KEYS.some((k) => !resolved[k]);
  if (needFile) {
    let fileEnv = {};
    try {
      fileEnv = parseEnvFile(readFileSync(filePath, "utf8"));
    } catch {
      fileEnv = {}; // missing fallback file is fine — env may be complete.
    }
    for (const k of KEYS) if (!resolved[k] && fileEnv[k]) resolved[k] = fileEnv[k];
  }

  return {
    secretKey: resolved.STRIPE_SECRET_KEY,
    webhookSecret: resolved.STRIPE_WEBHOOK_SECRET,
    proPriceId: resolved.STRIPE_PRO_PRICE_ID,
    missing: KEYS.filter((k) => !resolved[k]),
  };
}
