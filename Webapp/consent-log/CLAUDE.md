# consent-log — Hard Constraints

> Domain CLAUDE.md. Canonical for this package. The generator reads this before
> touching consent-log.

## What this package is

The FIXED server-enforced signup consent gate: a request-time check that refuses
to create an account without a fresh, version-pinned acceptance, plus the at-rest
schema that stores that acceptance in **server-write-only** columns. Built once,
configured per client only by the `CONSENT_VERSION` constant — never rebuilt.

## HARD constraints

- **Consent is enforced on the SERVER, before the account exists.** The browser
  checkbox is UI only; the box, the disabled button, and the hidden version field
  are all attacker-controlled. `requireConsent()` MUST run server-side and pass
  BEFORE the `auth.signUp` call. A flow that relies on a client-side `required`
  attribute to block signup is a finding, not a build — the gate is the product.

- **The consent record is SERVER-WRITE-ONLY. This is the load-bearing rule.**
  GDPR Art. 7(1) puts the burden on the *controller* to demonstrate consent. A
  consent row the account holder can write or backdate is worthless as evidence —
  it proves nothing, because the subject could have forged it. Therefore
  `consent_accepted_at` and `consent_version` MUST be written only by the server
  (service-role client) and MUST be absent from any UPDATE grant held by the user
  role (`authenticated`/`anon`). The record is the controller's evidence, not the
  user's editable field.

- **The carve-out is done the only way Postgres allows.** There is no
  column-scoped REVOKE that narrows a table-level grant. So: `revoke update on
  <table> from authenticated, anon` table-wide, then `grant update (<editable
  cols>) ... to authenticated` listing ONLY the user-editable columns. The consent
  columns are deliberately omitted. A column-level revoke layered on top of a
  surviving table-wide grant is the classic non-fix — it does NOT remove the
  access and is a finding.

- **RLS from the start, as the second lock.** The table ships row-level security
  (baseline §5): a user touches only their own row. RLS bounds *which* rows; the
  column grant bounds *which columns are writable at all*. Both are required — RLS
  alone still leaves the consent columns user-writable on the user's own row.

- **Version is pinned and re-consent is forced on change.** A stored consent must
  name the exact policy version agreed to. Bumping `CONSENT_VERSION` MUST cause a
  stale in-flight form to be rejected (`CONSENT_VERSION_STALE`), never silently
  recorded against the old text. The stored `consent_version` is stamped from the
  SERVER constant, never echoed back from raw client input.

- **Pure core, injected time.** `src/consent.mjs` reads no clock and does no I/O;
  the caller injects `at`. This keeps the gate unit-testable offline and the
  stamped record deterministic. No secrets, ever — the only config is a constant.

## What the evaluator checks here

- `requireConsent()` rejects missing/false/spoofed consent and missing/stale
  version with a structured error (proven in `selftest.mjs`).
- The migration revokes table-wide UPDATE from the user role and re-grants UPDATE
  on only the editable columns — `consent_accepted_at` / `consent_version` are NOT
  in the grant (server-write-only), confirmed by scanning the migration text, with
  the scanner first proven to fire on a deliberately-bad migration.
- RLS is enabled on the table.
- No secret or client-specific value in the package (only `CONSENT_VERSION`).

## What stays human (back gate)

The legal sufficiency of the policy/terms text, the lawful basis, and the
withdrawal / data-subject-access flows. This package makes the *signup*
acceptance enforceable and tamper-evident; whether the policy itself is adequate
is a human/legal judgement, not a machine check.
