# Ignored

The bundle is written to `build/out.js`, which this repository ignores.

A sibling checkout holds `../other/tool.ts`, which is outside this tree.

The scratch copy is `..cache/out.js`, a directory in this tree whose name only
starts with two dots.

The build runs:

```bash
node scripts/build.ts --bundle build/nested.js
```

Run `pnpm missing` here, which this manifest does not declare.
