---
okf_version: "0.2"
---

# ADR index

| Doc | Description |
|-----|-------------|
| [001-typescript-on-node-22-18.md](001-typescript-on-node-22-18.md) | Plugin code runs on Node 22.18 or newer. It executes erasable TypeScript directly, with no build step and explicit `.ts` imports. Plugins share one root `lib/` through a committed symlink. The command function is the test seam, and tests sit beside the code. No plugin carries its own `package.json`. |
| [002-quality-gate-venues.md](002-quality-gate-venues.md) | Local hooks run staged-only through lefthook, and never run a suite. CI runs everything as exact-named jobs, required by ruleset 22359720. Coverage stays at 100 on all four buckets, above a 95 floor. The Cobertura report feeds the enterprise Code Coverage ruleset. |
| [003-context-audit-model-boundary.md](003-context-audit-model-boundary.md) | The audit plugin has three model stages. They send repository text to TypeSafe only when `TYPESAFE_API_KEY` is set. They treat every judgment as advisory input, which a reviewer verifies rather than a gate. They reach the model through a `JevClient` in the shared `lib/`, behind an SDK-style interface, mocked at that boundary. |
