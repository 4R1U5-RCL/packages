# packages — reusable studio tooling

Standalone, reusable tooling that serves the studio but isn't part of any single
client build or the harness. Each package is self-contained and is **consumed by
pulling a pinned version**, never copy-forked into a container.

## Layout

- **[`Claude/`](Claude/)** — tooling for the Claude/agent side of the studio (the packages below).
- **[`Webapp/`](Webapp/)** — reusable web-app feature-packages extracted from Tessera (10 packages — see [`Webapp/README.md`](Webapp/README.md)).

## Packages (`Claude/`)

| Package | What it is |
|---------|------------|
| [`Claude/audit/`](Claude/audit/) | ATT&CK × ISO 27001 × SOC 2 security verification for the studio stack — a deterministic check core with three entry points (agent skill, CI gate, scheduled runner). Every check is self-guarded so a pass is earned, never assumed. |
| [`Claude/hygiene/`](Claude/hygiene/) | Config/codebase hygiene across three pluggable profiles (`--profile`, `--target`): `claude` (the IOPHON home tree — relocate stray files to their canonical home), `codebase` (a git work tree — git-aware self-verifying `backup` + read-only junk-drift report), and `llm-artifacts` (back up transcripts, exclude regenerable caches). `cleanup` drift detector + self-verifying `backup`; report-only on non-`claude` profiles (never moves/deletes). Three callers: agent skill, scheduled runner, CI drift gate. Every verdict is self-guarded so a pass is earned. |
| [`Claude/consult/`](Claude/consult/) | Multi-model cross-validation — the `research` and `validate` flows over one LiteLLM chain (base → GPT-5 → Gemini, optional Perplexity). The orchestration (escalation, agreement scoring) is self-guarded offline against recorded fixtures; a corroborated/HIGH verdict requires the corroborating tiers to have actually responded — absent a live proxy it returns `unknown`, never a fabricated answer. Confidence measures inter-model agreement, not correctness. |
| [`Claude/notify/`](Claude/notify/) | Claude Code → Telegram notifier. A `Notification`/`Stop` hook POSTs a signed event to the hosted `[STUDIO_NOTIFICATIONS]` n8n workflow, which pings Telegram (🟡 needs input / 🟢 done). Header-Auth + HMAC-signed; the live channel is proven via the n8n executions API, never assumed. |

## Conventions

- **Self-contained.** A package lives entirely under its own directory; nothing it
  needs sits elsewhere in the tree.
- **Pinned consumption.** Consumers pull a tagged version and reference it in
  place. Bump the pin deliberately. (The first tag is `v0.1.0`.)
