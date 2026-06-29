# consent-log — server-enforced GDPR signup consent gate

A self-contained, reusable package: a signup flow may not create an account
without a **fresh, version-pinned** acceptance of the Privacy Policy + Terms, and
the acceptance is persisted in **server-write-only** columns the user can never
write or backdate. The gate is the deliverable; the checkbox is just its UI.

It lives in the reusable-packages monorepo (`4R1U5-RCL/packages`) under
`Webapp/` and is **consumed by pulling a pinned version**, never copy-forked into
a client repo (copy-and-fork recreates exactly the per-client drift these
packages exist to prevent).

> **The one caveat to carry into every wiring.** A ticked box in the browser is
> not consent — the checkbox, the disabled button, and the hidden version field
> are all attacker-controlled. GDPR Art. 7(1) requires the *controller* to be able
> to **demonstrate** consent. That demonstration only exists if the **server**
> refuses to create the account without acceptance and writes the record itself,
> into columns the account holder cannot later alter. Everything here serves that
> one property; the `selftest` earns its green by proving the columns are actually
> off the user-writable surface, not by assuming it.

---

## Layout

```
consent-log/
├── src/consent.mjs        the PURE core — requireConsent() + stampConsent(),
│                          CONSENT_VERSION constant, structured ConsentRequiredError.
│                          Node 22 built-ins only, no clock, no I/O → unit-testable.
├── migrations/
│   └── 0001_signup_consent.sql   adds consent_accepted_at + consent_version, with
│                          column-level grants making them SERVER-WRITE-ONLY, + RLS.
├── reference/
│   └── signup.reference.ts   reference glue — wiring the gate into a Next.js/Supabase
│                          signup server action (enforce-before-create, service-role write).
├── selftest.mjs           offline earned checks (no network, no DB)
└── CLAUDE.md              the hard constraint: why consent must be server-written-only
```

## The two halves, and why both are needed

| Half | File | Enforces |
|------|------|----------|
| **Gate** (request time) | `src/consent.mjs` | No account is created without a current acceptance. Runs server-side, BEFORE the auth call, independent of the client. |
| **Record** (at rest) | `migrations/0001_signup_consent.sql` | The acceptance, once written by the server, cannot be altered or backdated by the account holder. Column-level grants + RLS. |

A gate without server-write-only columns can be re-written by the user afterwards;
server-write-only columns without a gate are never populated. The package is both.

## Config — a constant, never a secret

The only knob is `CONSENT_VERSION` in `src/consent.mjs` (e.g. `"2026-06-29"`).
Bump it whenever the Privacy Policy / Terms change. Two effects:

1. Every new consent record pins the version actually agreed to (Art. 7 evidence).
2. A user who loaded the signup form before the change is rejected with
   `CONSENT_VERSION_STALE` and must re-accept the current version — an old
   agreement is never silently recorded as if it were current.

There are **no secrets** in this package.

## The gate contract (`src/consent.mjs`)

```js
import { requireConsent, stampConsent, CONSENT_VERSION } from "@studio/consent-log/consent";

// Throws a structured ConsentRequiredError (.code, .toJSON()) on any failure;
// returns { accepted: true, version } on success.
requireConsent({ accepted: formData.get("consent"),
                 version: formData.get("consent_version") });

// Validates, then returns the exact server-write-only column shape to persist.
// Time is INJECTED (never read here) so the record is deterministic + testable.
const rec = stampConsent({ accepted, version }, { at: Date.now() });
// → { consent_accepted_at: "…ISO…", consent_version: CONSENT_VERSION, schema: "studio.consent.v1" }
```

Rejection codes (`ConsentErrorCode`): `CONSENT_NOT_ACCEPTED`,
`CONSENT_VERSION_MISSING`, `CONSENT_VERSION_STALE`.

## Wiring (see `reference/signup.reference.ts`)

1. **Enforce before create.** Call `requireConsent()` at the top of the signup
   server action; only reach `auth.signUp` if it passes. A forged form that omits
   the checkbox never creates an account or triggers a confirmation email.
2. **Write with the service role.** `consent_accepted_at` / `consent_version` are
   server-write-only — the user role has no UPDATE grant on them. Stamp with
   `stampConsent()` and write through the **service-role** client (bypasses RLS +
   column grants). The render side puts the live version in a hidden field:
   `<input type="hidden" name="consent_version" value={CONSENT_VERSION} />`.

## Run the earned checks

```sh
node selftest.mjs
```

Asserts: missing/false/spoofed consent rejected; missing/stale version rejected
distinctly; a genuine acceptance stamps `consent_accepted_at` + `consent_version`
exactly from an injected time; the rejection is a structured error; and — by
scanning the migration — that the consent columns are REVOKEd from self-update.
That last check is **proven to fire** on a deliberately-bad migration (a consent
column left inside the UPDATE grant) before it is trusted on the real one, so a
green is earned, not assumed.

## Boundary

- **In scope:** the request-time gate, the at-rest server-write-only record + RLS,
  the reference wiring, and the offline earned selftest.
- **Out of scope (named, not skipped):** rendering the consent UI/policy copy
  (the app owns that); the legal sufficiency of the policy text itself; consent
  *withdrawal* and data-subject-access flows (a separate surface). This package
  makes the *signup* acceptance enforceable and tamper-evident; it is not a full
  consent-management platform.
- **The honest line:** a green run proves the columns are off the user-writable
  surface and the gate rejects bad input — it does not make the deployment
  GDPR-*compliant* on its own (that needs the policy, the lawful basis, and the
  surrounding rights flows). It delivers the technical substance of demonstrable
  signup consent.
