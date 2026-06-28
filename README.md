# packages — reusable studio tooling

Standalone, reusable tooling that serves the studio but isn't part of any single
client build or the harness. Each package is self-contained and is **consumed by
pulling a pinned version**, never copy-forked into a container.

## Packages

| Package | What it is |
|---------|------------|
| [`audit/`](audit/) | ATT&CK × ISO 27001 × SOC 2 security verification for the studio stack — a deterministic check core with three entry points (agent skill, CI gate, scheduled runner). Every check is self-guarded so a pass is earned, never assumed. |
| [`hygiene/`](hygiene/) | Config-hygiene tooling for the IOPHON home tree — a `cleanup` drift detector (stray files vs. the canonical directory rules) and a self-verifying `backup` (sentinel-guarded archive). Three callers: agent skill, scheduled runner (the strong automation), and an honestly-scoped CI drift gate. Every verdict is self-guarded so a pass is earned. |
| [`consult/`](consult/) | Multi-model cross-validation — the `research` and `validate` flows over one LiteLLM chain (base → GPT-5 → Gemini, optional Perplexity). The orchestration (escalation, agreement scoring) is self-guarded offline against recorded fixtures; a corroborated/HIGH verdict requires the corroborating tiers to have actually responded — absent a live proxy it returns `unknown`, never a fabricated answer. Confidence measures inter-model agreement, not correctness. |

## Conventions

- **Self-contained.** A package lives entirely under its own directory; nothing it
  needs sits elsewhere in the tree.
- **Pinned consumption.** Consumers pull a tagged version and reference it in
  place. Bump the pin deliberately. (The first tag is `v0.1.0`.)
