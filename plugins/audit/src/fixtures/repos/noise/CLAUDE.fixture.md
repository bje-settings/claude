# Noise

The dependency `@scope/name` is a package and not a path in this tree.

The workflow pins `owner/name@v1.2.3`, which names a ref rather than a file.

A skill runs `${CLAUDE_PLUGIN_ROOT}/scripts/audit.ts`, filled in at run time.

The decision is recorded in `docs/adr/022`, whose file carries a slug.

An ambiguous one is `docs/adr/099`, which two files could answer to.

The bundle is written to `build/output.js`, which this repository ignores.

The failing line is `build/output.js:12`, in that same ignored bundle.

The workflow reads:

```yaml
jobs:
  build:
    steps:
      - uses: ./.github/workflows/ci.yml
      - run: pnpm test
```

The thread is at https://example.invalid#170 for anyone who wants it.

A skill also runs `$CLAUDE_PLUGIN_ROOT/scripts/audit.ts` with no braces at all.

A generated one is `dist/{name}/index.ts`, named by a brace and nothing else.

Another repository's bje-settings/claude#4242 is not this one's issue.

A diagram writes `classDef done fill:#000,color:#123` for the colours it wants.

A zero-padded #0170 is no issue number at all.

The docs are at `https://example.invalid/docs`, and `CLAUDE.md` is this file.
