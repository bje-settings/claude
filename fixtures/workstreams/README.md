# workstreams fixtures

Canned GitHub data for `spec/workstreams/`. Unlike `fixtures/gh/`, nothing here builds a git
repository: the workstreams scripts only read from `gh` and write a JSON state file, so the
fixtures are the data `gh` would return plus a fake `$HOME`.

## `bin/gh`

A stand-in for the gh CLI. Put the directory on `PATH` ahead of the real one. It emulates the
server-side filtering of `issue list` (`--state`, `--label`, `--milestone`, `--search`,
`--limit`), the `--json` field projection, and runs the caller's `--jq` with real jq, so the jq
in the scripts is exercised rather than assumed. Any flag it does not emulate exits 64 and any
subcommand it does not emulate exits 1, so a spec cannot pass against a query the real gh would
answer differently.

| Variable | Effect |
| --- | --- |
| `WS_GH_FIXTURE_DIR` | Directory holding `issues.json`, `prs.json`, `extensions.txt`; a missing file is an empty set |
| `WS_GH_FIXTURE_REPO` | `nameWithOwner` reported by `gh repo view` (default `bje-settings/example`) |
| `WS_GH_FIXTURE_FAIL` | Every call fails |
| `WS_GH_FIXTURE_NOAUTH` | `gh auth status` fails |

Supported: `auth status`, `extension list`, `repo view`, `issue view`, `issue list`, `pr view`.

## `fixtures.sh`

| Function | Produces |
| --- | --- |
| `ws_fixture_issues <path>` | Six issues reconstructing the shape of the field test in issue #7: a bug referencing two others, a bodiless chore, a refactor blocked on the bug, a spike in a milestone, a closed bug, and a docs issue whose body has a `#7` inside a url |
| `ws_fixture_prs <path>` | Five PRs covering every `checks` fold: pass, fail, pending, none, and a merged PR with a StatusContext |
| `ws_fixture_extensions <path> [with-stack\|without-stack]` | `gh extension list` output |
| `ws_fixture_installed_plugins <path> [with-review\|without-review]` | The shape of `~/.claude/plugins/installed_plugins.json` |
| `ws_fixture_home <dir> [with-skill\|without-skill]` | A fake `$HOME` with the gh-stack skill where `gh skill install` puts it |

`spec/workstreams/fixtures_spec.sh` asserts every claim in this table, so the other specs cannot
pass for the wrong reason.

`setup_ws_sandbox` in `spec/spec_helper.sh` wires all of this together for one example: a temp
dir with the canned data, an empty `WS_STATE_DIR`, a fake `HOME`, and the stub on `PATH`. Specs
remove or replace individual pieces to build the negative cases. `ws_path_without <tool>...`
builds a `PATH` missing the named tools for the "not installed" branches.
