# Opaque

Run this:

```bash
$ pnpm test
node scripts/build.ts --watch
```

And the shape of it:

```mermaid
graph TD
  A[fix #4242] --> B[docs/gone.md]
```

And an example from elsewhere:

```bash
# see scripts/build.ts:1 for the entry point
node ../other/tool.ts
```

And one with no language at all:

```
node scripts/build.ts
```

And a snippet that only looks like it names one:

```ts
if (ready) {
  run('scripts/build.ts')
}
```
