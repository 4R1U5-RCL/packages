# Security Coverage Matrix

**Current as of MITRE ATT&CK Enterprise v19.1** (live source of truth:
`mapping/ATTACK_VERSION` + the `matrix-freshness` check, which polls
`https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/index.json`).

This matrix maps each deterministic control the package runs to the best-fitting
MITRE ATT&CK Enterprise technique(s), ISO/IEC 27001:2022 Annex A control(s), and
SOC 2 (AICPA Trust Services) Common Criteria. The full citation set lives once in
`mapping/controls.json`; this file is the human-readable view.

**What "coverage" means here.** Coverage is *which adversary techniques the package
mechanically checks for* — not a claim that the stack is correctly configured. A
green run only certifies that the negative control was injected and fired (see
`checks/_common.mjs`, the honest-pass rule). **A green run on a misconfigured policy
is worse than a red one**: it manufactures false assurance. Treat every "pass" as
"the guard fired against a known-bad input," nothing more.

**Out of scope.** Organizational SOC 2 controls — security policies, incident
response, the change-management process, vendor risk, the observation-period
itself — are *not* implemented by this package. The package is a set of technical
checks against a repo and live infra; it can report the *absence* of a technical
control that an organizational policy would require, but it cannot implement,
attest, or substitute for the organizational controls a SOC 2 audit examines. The
ISO/SOC columns below are mapping references, not an attestation of compliance.

Surface · reach: `repo`/`app`/`infra` × `static` (source-reachable, CI-runnable)
or `dynamic` (needs a live endpoint / state document). OWASP column cites the
2021 Top 10 item where the control is an OWASP check.

| Control | Surface · reach | OWASP | ATT&CK technique(s) | ISO 27001:2022 Annex A | SOC 2 CC | One-line rationale |
|---|---|---|---|---|---|---|
| **rls** — Row-Level Security on all app-data tables | repo · static | A01 | T1213 Data from Information Repositories (Collection); T1190 Exploit Public-Facing Application (Initial Access) | A.8.3 Information access restriction; A.5.15 Access control | CC6.1; CC6.3 | RLS bounds what a role (anon) can read out of the DB via the public API, blocking bulk read of another tenant's rows. |
| **revoke** — REVOKE discipline on PII tables | repo · static | A01 | T1078 Valid Accounts (Initial Access / Persistence / Privilege Escalation / Stealth); T1213 Data from Information Repositories (Collection) | A.8.3 Information access restriction; A.5.18 Access rights | CC6.3; CC6.1 | Stripping default grants from anon/public removes the over-permissioned built-in role an attacker would ride to reach PII. |
| **secret-leak** — No secrets committed to the repo | repo · static | — | T1552.001 Unsecured Credentials: Credentials In Files (Credential Access) | A.5.17 Authentication information; A.8.4 Access to source code | CC6.1; CC6.3 | Keeping API keys/JWTs out of tracked files (.env gitignored) denies the exact credentials-in-files theft of T1552.001. |
| **security-headers** — Security response headers present | app · static | A05 | T1189 Drive-by Compromise (Initial Access); T1059.007 Command and Scripting Interpreter: JavaScript (Execution) | A.8.26 Application security requirements; A.8.9 Configuration management | CC6.6; CC7.1 | CSP/HSTS/X-Frame-Options/X-Content-Type-Options/Referrer-Policy harden the browser against injected script, framing and content-type confusion. |
| **dependency-audit** — Dependency-CVE alerting configured | app · static | A06 | T1195.001 Compromise Software Dependencies and Development Tools (Initial Access); T1190 Exploit Public-Facing Application | A.8.8 Management of technical vulnerabilities; A.8.25 Secure development life cycle | CC7.1; CC3.2 | Configured Dependabot/SCA alerting catches vulnerable/outdated components before a known CVE in a dependency becomes a path in. |
| **app-logging** — App-side security-event logging present | app · static | A09 | T1562.008 Impair Defenses: Disable or Modify Cloud Logs (Stealth) | A.8.15 Logging; A.8.16 Monitoring activities | CC7.2; CC7.3 | Logging auth/security events denies the attacker the unlogged blind spot; verifies the *wiring* is present, not log completeness. |
| **access-probe** — Object-level access control (no IDOR) | app · dynamic | A01 | T1190 Exploit Public-Facing Application (Initial Access); T1213 Data from Information Repositories (Collection) | A.8.3 Information access restriction; A.5.15 Access control | CC6.1; CC6.3 | Probes IDOR from outside the running app — the app-dynamic view of the same access-control boundary rls/revoke verify in policy. |
| **cookie-flags** — Session cookie HttpOnly + Secure + SameSite | app · dynamic | A07 | T1539 Steal Web Session Cookie (Credential Access); T1550.004 Use Alternate Authentication Material: Web Session Cookie (Lateral Movement) | A.8.5 Secure authentication; A.8.24 Use of cryptography | CC6.1; CC6.7 | HttpOnly keeps the cookie from injected JS, Secure binds it to TLS, SameSite blocks cross-site send — denying cookie theft and replay. |
| **ssrf** — SSRF protection on the scraping path | infra · dynamic | A10 | T1552.005 Unsecured Credentials: Cloud Instance Metadata API (Credential Access); T1190 Exploit Public-Facing Application (Initial Access) | A.8.26 Application security requirements; A.8.20 Networks security | CC6.6; CC6.1 | Blocking server-side requests to localhost/link-local (169.254.169.254) denies SSRF-to-metadata credential theft. Reused for app endpoints via config. |
| **webhook-auth** — Inbound webhook HMAC-SHA256 + replay window | infra · dynamic | — | T1565.002 Data Manipulation: Transmitted Data Manipulation (Impact); T1684.001 Social Engineering: Impersonation (Stealth) | A.8.24 Use of cryptography; A.8.26 Application security requirements | CC6.7; CC6.1 | Verifying the HMAC signature + replay window rejects forged/replayed payloads injected by an actor impersonating the sender. |
| **dns-auth** — Email SPF / DKIM / DMARC | infra · dynamic | — | T1684.002 Social Engineering: Email Spoofing (Stealth); T1566 Phishing (Initial Access) | A.5.14 Information transfer; A.8.24 Use of cryptography | CC6.7; CC6.1 | Well-formed SPF/DKIM/DMARC stop an adversary spoofing the sending domain to phish (T1684.002 cites SPF/DKIM/DMARC by name). |
| **supabase-logging** — Auth/API logging + log drain enabled | infra · dynamic | A09 | T1562.008 Impair Defenses: Disable or Modify Cloud Logs (Stealth) | A.8.15 Logging; A.8.16 Monitoring activities | CC7.2; CC7.3 | The smoke detector installed and powered — a config-presence check; it does not claim anyone reads the logs (practice, not check). |
| **gh-secret-scanning** — Secret scanning + push protection on | infra · dynamic | — | T1552.001 Unsecured Credentials: Credentials In Files (Credential Access); T1195 Supply Chain Compromise (Initial Access) | A.8.4 Access to source code; A.8.28 Secure coding | CC7.1; CC6.1 | Secret scanning detects committed credentials and push protection blocks them at commit. Detection-config complement of secret-leak. |
| **device-signin-alerts** — Apex-identity new-device alerts | infra · dynamic | — | T1078 Valid Accounts; T1110 Brute Force (Credential Access) | A.8.16 Monitoring activities; A.5.17 Authentication information | CC7.2; CC6.1 | New-device alerts on the apex Google/GitHub identities surface a compromised/brute-forced account on first use from an unfamiliar device. |
| **vercel-observability** — Observability + firewall configured | infra · dynamic | — | T1190 Exploit Public-Facing Application (Initial Access); T1499 Endpoint Denial of Service (Impact) | A.8.16 Monitoring activities; A.8.20 Networks security | CC7.2; CC6.6 | Observability gives request/runtime telemetry to spot exploitation; the firewall blunts edge abuse and DoS at the boundary. |
| **alert-route** — Test event reaches the alert channel | infra · dynamic | A09 | — (delivery/plumbing control; maps to no technique) | A.8.16 Monitoring activities; A.5.24 Information security incident management planning | CC7.3; CC7.4 | Closes detection→response: a test event must actually arrive. **STUBBED (notify/, n8n pending) → `unknown` by construction** until watched to arrive. |
| **matrix-freshness** — Bundled ATT&CK matches MITRE's current release | infra · dynamic | — | — (meta/currency control; maps to no technique) | A.5.7 Threat intelligence; A.8.8 Management of technical vulnerabilities | CC7.1; CC3.2 | Keeping the bundled matrix in step with MITRE's published Enterprise release is threat-intel currency, not an adversary behaviour. |

## Notes on weaker / version-sensitive mappings

- **ATT&CK v19 restructure (verified live, 2026-06-27).** TA0005 is now named
  **"Stealth"** (formerly "Defense Evasion"). The old **T1656 Impersonation** no
  longer exists as a standalone technique; it is now **T1684 Social Engineering**
  with sub-techniques **T1684.001 Impersonation** and **T1684.002 Email Spoofing**.
  `webhook-auth` and `dns-auth` cite the new IDs — any lingering `T1656` reference
  is stale.
- **revoke / T1078 Valid Accounts** carries four tactics; the mapping is to the
  least-privilege-hardening intent (reducing the standing power of the anon/public
  role), not to a single kill-chain stage.
- **matrix-freshness has no ATT&CK technique** (`attack: []` in controls.json) by
  design — it is a maintenance control, mapped only to governance clauses (A.5.7 /
  CC7.1). `CC9.1` was considered and dropped (it is business-*disruption* risk, not
  threat-knowledge currency).
- **secret-leak / CC6.3** is a supporting secondary only — CC6.3 governs
  granting/removing access, while the control protects stored secrets; CC6.1
  (credential management) is the primary.
- **OWASP `app` surface (added).** The OWASP column maps each `app` check (and
  the access-control repo checks) to its 2021 Top 10 item. A01 is single-homed
  across `rls`/`revoke` (policy) and `access-probe` (the running app); A10 reuses
  `ssrf` against app endpoints; A06 is `dependency-audit`. **Named, not-yet-built
  OWASP gaps** — A02 (crypto/TLS depth), A03 (injection / stored-XSS render path),
  A04 (auth rate-limiting / business-logic), A08 (CI/CD integrity) — need a live
  target or are judgemental, and are deliberately *not* faked as green checks.
- **alert-route has no ATT&CK technique** (`attack: []`, like matrix-freshness) —
  it is a detection→response delivery control, mapped to A.8.16 / A.5.24 and
  CC7.3 / CC7.4. It is currently **stubbed** (`notify/`, n8n pending) and reports
  `unknown` by construction; it must never read as green until a real test event
  is watched to arrive.
- **The logging/detection config checks** (`supabase-logging`,
  `gh-secret-scanning`, `device-signin-alerts`, `vercel-observability`) verify a
  control is *installed and enabled* — the mechanical half. Whether anyone reads
  the resulting logs/alerts is *practice*, owned by the companion IR / Logging &
  Detection docs, never a check here.
