# field-test fixtures

Canned input for the harden-side specs in `spec/field-test/`. The run side of the plugin is
Python, and its fixtures live in `tests/field-test/conftest.py` beside the tests that read them;
issue #60 moves what is left here across with the scripts that still read it.

**Canned gh answers**, served by `bin/gh`: the pull requests `ft_fixture_prs` writes, one per arm
of `checks.jq`, and the reports `ft_fixture_report` writes for the verifier. The stub filters and
projects them the way the real gh does, so the jq in the scripts runs against them unchanged.

Nothing here was copied from a repository outside the `bje` enterprise. The shapes are
reconstructed from field tests of `/gh:shepherd` and `/workstreams:run`; the names (`acme-org`,
`acme-tools`, `widgets`) are invented.

## `bin/gh`

A stand-in for the gh CLI. Put the directory on `PATH` ahead of the real one, or point `FT_GH`
at it. Like the other gh stubs in this repository it applies the filtering the real gh applies
server-side, projects the fields named by `--json`, and runs the caller's `--jq` with real jq, so
the jq in the scripts is exercised rather than assumed. An unknown flag exits 64, an unknown
`--json` field exits 1 the way gh's "Unknown JSON field" does, and an unemulated subcommand exits
1, so a spec cannot pass against a query the real gh would answer differently.

Supported: `auth status` and `pr view`, which is what the harden-side scripts ask for. The run
side's queries (the enterprise query, `issue list`, `label create`) are answered by the Python
stub at `tests/field-test/bin/gh`.

A pull request record may carry a `sequence` array. Each `pr view` call shifts the first entry off
it and merges it over the record, so a spec can watch a pull request move from pending to green
across polls the way a real one does.

| Variable | Effect |
| --- | --- |
| `FT_GH_FIXTURE_DIR` | Directory holding `prs.json` |
| `FT_GH_FIXTURE_FAIL` | Every call fails |

## `fixtures.sh`

| Function | Produces |
| --- | --- |
| `ft_fixture_installed_plugins <path> <install-dir>` | The shape of `~/.claude/plugins/installed_plugins.json`, version 2, as the harden preflight reads it |
| `ft_fixture_prs <path>` | Twelve pull requests, one per arm of `checks.jq` plus merged, closed, and two that change across polls |
| `ft_fixture_report <path> <case>` | What a field-test report claimed: `accurate`, `wrong`, `unknown` (a word the verifier cannot check), `missing` (a pull request that does not exist) |

`spec/field-test/fixtures_spec.sh` asserts the claims the other specs rely on: what the gh stub
refuses to answer, which check verdict every fixture pull request folds to, that a sequenced pull
request moves across polls and stays at its final state afterwards, and which claims each report
case makes.

`setup_ft_sandbox` in `spec/spec_helper.sh` wires it together for one example: a temp state
directory, a fake `HOME` with Claude's plugin registry, the canned pull requests, and the stub on
`PATH`. Specs replace individual pieces to build the negative cases.
