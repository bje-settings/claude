# Ignored

The bundle is written to `build/out.js`, which this repository ignores.

A sibling checkout holds `../other/tool.ts`, which is outside this tree.

The build runs:

```bash
node scripts/build.ts --bundle build/nested.js
```

Run `pnpm missing` here, which this manifest does not declare.
