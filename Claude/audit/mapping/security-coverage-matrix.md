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
`checks/_common.py`, the honest-pass rule). **A green run on a misconfigured policy
is worse than a red one**: it manufactures false assurance. Treat every "pass" as
"the guard fired against a known-bad input," nothing more.

**Out of scope.** Organizational SOC 2 controls — security policies, incident
response, the change-management process, vendor risk, the observation-period
itself — are *not* implemented by this package. The package is a set of technical
checks against a repo and live infra; it can report the *absence* of a technical
control that an organizational policy would require, but it cannot implement,
attest, or substitute for the organizational controls a SOC 2 audit examines. The
ISO/SOC columns below are mapping references, not an attestation of compliance.

| Control | Surface | ATT&CK technique(s) | ISO 27001:2022 Annex A | SOC 2 CC | One-line rationale |
|---|---|---|---|---|---|
| **rls** — Row-Level Security on all app-data tables | repo | T1213 Data from Information Repositories (Collection); T1190 Exploit Public-Facing Application (Initial Access) | A.8.3 Information access restriction; A.5.15 Access control | CC6.1; CC6.3 | RLS bounds what a role (anon) can read out of the DB via the public API, blocking bulk read of another tenant's rows. |
| **revoke** — REVOKE discipline on PII tables | repo | T1078 Valid Accounts (Initial Access / Persistence / Privilege Escalation / Stealth); T1213 Data from Information Repositories (Collection) | A.8.3 Information access restriction; A.5.18 Access rights | CC6.3; CC6.1 | Stripping default grants from anon/public removes the over-permissioned built-in role an attacker would ride to reach PII. |
| **ssrf** — SSRF protection on the scraping path | infra | T1552.005 Unsecured Credentials: Cloud Instance Metadata API (Credential Access); T1190 Exploit Public-Facing Application (Initial Access) | A.8.26 Application security requirements; A.8.20 Networks security | CC6.6; CC6.1 | Blocking server-side requests to localhost/link-local (169.254.169.254) denies SSRF-to-metadata credential theft. |
| **webhook-auth** — Inbound webhook HMAC-SHA256 + replay window | infra | T1565.002 Data Manipulation: Transmitted Data Manipulation (Impact); T1684.001 Social Engineering: Impersonation (Stealth) | A.8.24 Use of cryptography; A.8.26 Application security requirements | CC6.7; CC6.1 | Verifying the HMAC signature + replay window rejects forged/replayed payloads injected by an actor impersonating the sender. |
| **dns-auth** — Email SPF / DKIM / DMARC | infra | T1684.002 Social Engineering: Email Spoofing (Stealth); T1566 Phishing (Initial Access) | A.5.14 Information transfer; A.8.24 Use of cryptography | CC6.7; CC6.1 | Well-formed SPF/DKIM/DMARC stop an adversary spoofing the sending domain to phish (T1684.002 cites SPF/DKIM/DMARC by name). |
| **secret-leak** — No secrets committed to the repo | repo | T1552.001 Unsecured Credentials: Credentials In Files (Credential Access) | A.5.17 Authentication information; A.8.4 Access to source code | CC6.1; CC6.3 | Keeping API keys/JWTs out of tracked files (.env gitignored) denies the exact credentials-in-files theft of T1552.001. |
| **matrix-freshness** — Bundled ATT&CK matches MITRE's current release | infra | — (meta/currency control; maps to no technique) | A.5.7 Threat intelligence; A.8.8 Management of technical vulnerabilities | CC7.1; CC3.2 | Keeping the bundled matrix in step with MITRE's published Enterprise release is threat-intel currency, not an adversary behaviour. |

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
