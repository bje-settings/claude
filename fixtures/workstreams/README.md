# workstreams fixtures

Canned GitHub data for the workstreams specs that are still bash: `ws-preflight.sh`,
`ws-issues.sh` and `ws-pr-status.sh`. The ported scripts use the Python counterpart of all of
this, in `tests/workstreams/` (`conftest.py` and `bin/gh`), which keeps the same environment
contract; when the last of those three is ported, in #55, this directory goes with it.

Unlike `fixtures/gh/`, nothing here builds a git repository: the workstreams scripts only read
from `gh` and write a JSON state file, so the fixtures are the data `gh` would return plus a fake
`$HOME`.

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
| `ws_fixture_issues <path>` | Seven records reconstructing the shape of the field test in issue #7: a bug referencing two others, a bodiless chore, a refactor blocked on the bug that also mentions itself, a spike in a milestone, a closed bug, a docs issue whose body has a `#7` inside a url, and a pull request that `gh issue view` answers for |
| `ws_fixture_prs <path>` | Nine PRs covering every `checks` fold: pass, fail, pending, none, a merged PR with a StatusContext, and one PR each for CANCELLED, NEUTRAL, a completed run with no conclusion, and STALE |
| `ws_fixture_extensions <path> [with-stack\|without-stack]` | `gh extension list` output |
| `ws_fixture_installed_plugins <path> [with-review\|without-review]` | The shape of `~/.claude/plugins/installed_plugins.json` |
| `ws_fixture_home <dir> [with-skill\|without-skill]` | A fake `$HOME` with the gh-stack skill where `gh skill install` puts it |

`spec/workstreams/fixtures_spec.sh` asserts the shapes the other specs rely on (counts, states,
references, which conclusions appear), so those specs cannot pass for the wrong reason.
`tests/workstreams/test_ws_fixtures.py` makes the same claims about the Python fixtures.

`setup_ws_sandbox` in `spec/spec_helper.sh` wires all of this together for one example: a temp
dir with the canned data, an empty `WS_STATE_DIR`, a fake `HOME`, and the stub on `PATH`. Specs
remove or replace individual pieces to build the negative cases. `ws_path_without <tool>...`
builds a small `PATH` (the stub plus the tools the scripts call) missing the named tools, for the
"not installed" branches.
