---
okf_version: "0.2"
---

# RFC index

| Doc | Description |
|-----|-------------|
| [001-typescript-port.md](001-typescript-port.md) | Moves the marketplace's plugin scripts off Python 3.9, onto TypeScript. TypeScript runs directly on Node 22.18 or newer. Every plugin symlinks in one root `lib/`, and tests sit beside the code. The local and CI quality gates split by venue. |
