# Contributing

## Tests

```bash
spec/run.sh
```

Specs live in `spec/`, fixtures in `fixtures/<plugin>/`. See `fixtures/gh/README.md` and `fixtures/workstreams/README.md`.
Requires `shellspec` and `jq`; `shellcheck` is used if present.

## Local install

Add the marketplace locally for testing:

```bash
/plugin marketplace add ./path/to/this/repo
/plugin install gh@bje
/plugin install workstreams@bje
/plugin install field-test@bje
```
