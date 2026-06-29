// consent-log/src/consent.mjs — the server-enforced signup consent gate (pure core).
//
// Node 22 built-ins only. No npm deps. (Same discipline as ~/packages/Claude/notify
// and ~/packages/Claude/audit.) This module is the ONE place the consent rule and
// the consent-record shape are defined, so the signup server action
// (reference/signup.reference.ts) and the selftest speak the same contract.
//
// The rule is deliberately tiny and PURE so it is unit-testable offline and can run
// in the same request the account is created in — BEFORE any auth call. Time is
// ALWAYS injected by the caller (`at`), never read here (mirrors notify's "this pkg
// never calls Date.now itself"), so a test can assert the stamped record exactly.
//
// WHY a server gate at all: a client-side "you must tick the box" is decoration —
// the box, the disabled button, and the hidden version field are all attacker-
// controlled. GDPR Art. 7 requires the controller to *demonstrate* consent. That
// demonstration only exists if the SERVER refuses to create the account without a
// fresh, version-pinned acceptance and writes that record itself. See CLAUDE.md.

/**
 * The version of the Privacy Policy + Terms a user accepts at signup. Bump this
 * string whenever those documents change, so every consent record pins the exact
 * version the user actually agreed to (GDPR Art. 7(1): the controller must be able
 * to show *what* was consented to, not merely *that* something was).
 *
 * This is the single config knob for the package — a constant, never a secret.
 */
export const CONSENT_VERSION = "2026-06-29";

/** Schema tag stamped on every consent record, so a stored row is self-describing. */
export const CONSENT_SCHEMA = "studio.consent.v1";

/** Structured, machine-readable reasons a consent check can fail. */
export const ConsentErrorCode = Object.freeze({
  NOT_ACCEPTED: "CONSENT_NOT_ACCEPTED",       // box unchecked / absent / not literally true
  VERSION_MISSING: "CONSENT_VERSION_MISSING", // accepted but no policy version was submitted
  VERSION_STALE: "CONSENT_VERSION_STALE",     // accepted an OLD policy version while a newer one is live
});

/**
 * A structured rejection. Carries a stable `.code` (one of ConsentErrorCode), the
 * offending `.field`, and a `.toJSON()` so a server action can return it to the UI
 * (or log it) without leaking a stack trace. This IS the "structured error" the
 * gate returns/throws.
 */
export class ConsentRequiredError extends Error {
  constructor(code, message, { field = "consent", expectedVersion, gotVersion } = {}) {
    super(message);
    this.name = "ConsentRequiredError";
    this.code = code;
    this.field = field;
    this.expectedVersion = expectedVersion;
    this.gotVersion = gotVersion;
  }
  toJSON() {
    return {
      error: "consent_required",
      code: this.code,
      field: this.field,
      message: this.message,
      expectedVersion: this.expectedVersion,
      gotVersion: this.gotVersion,
    };
  }
}

/** A submitted checkbox/flag counts as accepted ONLY for an explicit true.
 *  Native HTML checkboxes submit the string `"on"` when ticked and nothing when
 *  not — both are honoured; everything else (false, "false", "", undefined) is a
 *  rejection, never a coerced truthy pass. */
function isAccepted(accepted) {
  return accepted === true || accepted === "on" || accepted === "true";
}

/**
 * Enforce the consent gate. PURE: no clock, no I/O.
 *
 * Throws a {@link ConsentRequiredError} (structured, with `.code`) when consent is
 * missing, not literally accepted, or pins a version other than the live
 * `CONSENT_VERSION`. The stale-version check is the subtle one: a user who loaded
 * the form before a policy change must re-consent to the new version rather than
 * silently have an old agreement recorded as if it were current.
 *
 * @param {{accepted?: unknown, version?: unknown}} input  raw form input
 * @param {{currentVersion?: string}} [opts]  the live policy version (defaults to CONSENT_VERSION)
 * @returns {{accepted: true, version: string}}  the validated consent on success
 * @throws {ConsentRequiredError}
 */
export function requireConsent({ accepted, version } = {}, { currentVersion = CONSENT_VERSION } = {}) {
  if (!isAccepted(accepted)) {
    throw new ConsentRequiredError(
      ConsentErrorCode.NOT_ACCEPTED,
      "You must accept the Privacy Policy and Terms to create an account.",
      { expectedVersion: currentVersion, gotVersion: version ?? null },
    );
  }
  if (version == null || version === "") {
    throw new ConsentRequiredError(
      ConsentErrorCode.VERSION_MISSING,
      "Consent was accepted but no policy version was submitted.",
      { field: "consent_version", expectedVersion: currentVersion, gotVersion: null },
    );
  }
  if (String(version) !== currentVersion) {
    throw new ConsentRequiredError(
      ConsentErrorCode.VERSION_STALE,
      "The Privacy Policy has changed. Please review and accept the current version.",
      { field: "consent_version", expectedVersion: currentVersion, gotVersion: String(version) },
    );
  }
  return { accepted: true, version: currentVersion };
}

/**
 * Build the consent record to persist, AFTER validating the gate. The returned
 * shape uses the exact server-write-only column names from
 * migrations/0001_signup_consent.sql, so the server action can spread it straight
 * into the service-role write.
 *
 * Note `consent_version` is the SERVER's `currentVersion`, never the raw client
 * string — `requireConsent` has already proven they are equal, but the record is
 * stamped from the trusted source on purpose.
 *
 * @param {{accepted?: unknown, version?: unknown}} input  raw form input
 * @param {{at: number|string|Date, currentVersion?: string}} ctx  injected time + live version
 * @returns {{consent_accepted_at: string, consent_version: string, schema: string}}
 * @throws {ConsentRequiredError}
 */
export function stampConsent(input, { at, currentVersion = CONSENT_VERSION } = {}) {
  const ok = requireConsent(input, { currentVersion });
  if (at == null) {
    throw new TypeError("stampConsent: `at` (acceptance time) must be injected by the caller.");
  }
  return {
    consent_accepted_at: new Date(at).toISOString(),
    consent_version: ok.version,
    schema: CONSENT_SCHEMA,
  };
}
