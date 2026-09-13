---
okf_version: "0.2"
---

# ADR index

| Doc | Description |
|-----|-------------|
| [001-typescript-on-node-22-18.md](001-typescript-on-node-22-18.md) | Plugin code runs on Node 22.18 or newer, executing erasable TypeScript directly with no build step and explicit `.ts` imports, sharing one root `lib/` through a committed symlink, with the command function as the test seam, tests co-located beside the code, and no plugin carrying its own `package.json`. |
| [002-quality-gate-venues.md](002-quality-gate-venues.md) | Local hooks run staged-only through lefthook and never run a suite, CI runs everything as exact-named jobs required by ruleset 22359720, and coverage is held at 100 on all four buckets above a 95 floor with the Cobertura report feeding the enterprise Code Coverage ruleset. |
