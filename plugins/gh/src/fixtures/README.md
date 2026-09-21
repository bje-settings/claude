# plugins/gh/src/fixtures

The captured contract the TypeScript sync commands are compared against. Everything here came out
of the Python that is still in the tree at `plugins/gh/scripts/`, **before** any of it was ported,
and nothing here is hand-written or edited afterwards: #127 layer 4 deletes that Python, and a
fixture edited to fit the port would prove the port against itself.

`vitest` and the coverage reporter both exclude `**/fixtures/**`, so these files are data the tests
read and never code that runs.

| File | Where it came from |
| --- | --- |
| `bash-output.json` | `tests/gh/golden/bash-output.json`, copied byte for byte at `02fadf3`. Captured from `gh-sync-repo.sh` before the shell script was deleted, over the scenarios in `tests/gh/scenarios.py`, with commit hashes and the sandbox path normalised out. |
| `bash-sync-output.json` | `tests/gh/golden/bash-sync-output.json`, copied byte for byte at `62799d0`. The same capture for `gh-sync.sh`, over the scenarios in `tests/gh/test_gh_sync.py`. |
| `divergences.json` | The divergence table of `tests/gh/test_output_parity.py`, ported as data, plus what the pnpm-only ruling does to three scenarios' inputs. |
| `python-cli-output.json` | Generated: `plugins/gh/scripts/gh-sync.py`, `gh-sync-repo.py` and `lib/discover.py` run over the states their own tests build, at `cb8fb06`, normalised the same way (and then formatted by biome, which touches whitespace only, because this directory is inside the formatter's scope while `tests/gh/golden` is excluded from it). It holds the contracts the two goldens do not: argument refusals, their exit statuses, the help text, and discovery's own stdout. |

`commands/sync-repo.test.ts` reads `bash-output.json`, `commands/sync.test.ts` reads
`bash-sync-output.json`, both read `divergences.json`, and those two plus `discover.test.ts` read
`python-cli-output.json`. Each parity test lives beside the command it is about rather than in a
file of its own, which is the layout rule in `.claude/rules/type-ts.md`.

## Why a capture and not a second suite

The acceptance line on #127 is that the port's output is byte-identical on the same repository
state. A test that asserted the port's own strings would pass whatever the port printed. These
files are the only record of what the Python printed that survives layer 4, so the capture commit
comes first, alone, and every later commit is checked against it.

## What the goldens do not prove

`bash-output.json` records one shell run per scenario. Where the port deliberately says something
else, `divergences.json` names the line that changed and why, so a divergence stays countable
rather than dissolving into a rewritten expectation. Three scenarios build a `package-lock.json` in
the Python; under the pnpm-only ruling the port builds `pnpm-lock.yaml` for the same state, and the
reported line is unchanged, which is why the golden still applies to them.
