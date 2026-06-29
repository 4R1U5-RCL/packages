// src/scan-migration.mjs — billing-grant scanner (CORE).
//
// PURE, dependency-free. Statically inspects a SQL migration to PROVE the
// server-write-only invariant: the billing columns must NEVER appear in the
// column list of a `GRANT UPDATE (...) ... TO authenticated`. A leak there would
// let an authenticated user set their own `plan`/subscription state — a real
// privilege-escalation / data-integrity bug. Also confirms RLS is enabled and a
// REVOKE of broad UPDATE from `authenticated` is present.
//
// Used by selftest.mjs against BOTH the real migration (must pass) and a
// deliberately-broken one that leaks a billing column (must be caught) — the
// negative control that proves the scan actually bites.

const BILLING_COLUMNS = [
  "plan",
  "stripe_customer_id",
  "stripe_subscription_id",
  "subscription_status",
  "current_period_end",
];

/** Strip `-- line` and `/* block *\/` comments so they can't hide a grant. */
function stripComments(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

/**
 * Find every `GRANT UPDATE ... TO authenticated`. Returns one entry per grant:
 *   { columns: string[]|null }  — the parenthesised column list, or null when the
 *   grant is TABLE-WIDE (no column list = grants UPDATE on ALL columns, the worst
 *   kind of leak).
 */
function authenticatedUpdateGrants(sql) {
  const grants = [];
  // GRANT UPDATE [(col, col)] ON [TABLE] <name> TO ... authenticated ...
  const re = /grant\s+update\s*(\(([^)]*)\))?\s+on\s+(?:table\s+)?[^\s]+\s+to\s+([^;]+);/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const roles = m[3].toLowerCase();
    if (!/\bauthenticated\b/.test(roles)) continue;
    if (m[2] === undefined) {
      grants.push({ columns: null }); // table-wide grant
    } else {
      const columns = m[2]
        .split(",")
        .map((c) => c.trim().replace(/"/g, "").toLowerCase())
        .filter(Boolean);
      grants.push({ columns });
    }
  }
  return grants;
}

/**
 * Scan a migration. Returns a structured verdict; `ok` is true only when every
 * security property holds.
 *
 * @param {string} sql
 * @returns {{
 *   ok: boolean,
 *   rlsEnabled: boolean,
 *   revokesUpdate: boolean,
 *   userUpdateColumns: string[],
 *   billingColumnsInUserGrant: string[],
 *   tableWideUserGrant: boolean,
 * }}
 */
export function scanMigration(sql) {
  const clean = stripComments(sql);

  const rlsEnabled = /enable\s+row\s+level\s+security/i.test(clean);
  const revokesUpdate =
    /revoke\s+[\s\S]*?update[\s\S]*?\bfrom\s+[^;]*\bauthenticated\b/i.test(clean);

  const grants = authenticatedUpdateGrants(clean);
  const tableWideUserGrant = grants.some((g) => g.columns === null);

  const userUpdateColumns = [
    ...new Set(grants.flatMap((g) => g.columns ?? [])),
  ];
  const billingColumnsInUserGrant = BILLING_COLUMNS.filter((c) =>
    userUpdateColumns.includes(c),
  );

  const ok =
    rlsEnabled &&
    revokesUpdate &&
    !tableWideUserGrant &&
    billingColumnsInUserGrant.length === 0;

  return {
    ok,
    rlsEnabled,
    revokesUpdate,
    userUpdateColumns,
    billingColumnsInUserGrant,
    tableWideUserGrant,
  };
}

export { BILLING_COLUMNS };
