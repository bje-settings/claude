# field-test fixtures

Canned input for `spec/field-test/`. Two kinds live here, for two different reasons.

**Real git repositories**, built by `ft_fixture_repo`. The redaction table is derived from a
checkout's actual remote, branches, and commit subjects, and redaction is the one thing in this
plugin that can leak a name into a public issue. A mocked `git` would prove nothing about it, so
the specs assert against repositories that exist.

**Recorded events**, one file per branch of `plugins/field-test/scripts/lib/collect.jq`. A
multi-line jq program is a single line to kcov, so a branch with no example reads as covered while
being untested; `.claude/rules/type-jq.md` asks for one fixture per arm and these are those arms.

Nothing here was copied from a repository outside the `bje` enterprise. The shapes are
reconstructed from field tests of `/gh:shepherd` and `/workstreams:run`; the names (`acme-org`,
`acme-tools`, `widgets`) are invented.

## `bin/gh`

A stand-in for the gh CLI. Put the directory on `PATH` ahead of the real one, or point `FT_GH`
at it. Like the other two stubs in this repository it applies the filtering the real gh applies
server-side, projects the fields named by `--json`, and runs the caller's `--jq` with real jq, so
the jq in the scripts is exercised rather than assumed. An unknown flag exits 64, an unknown
`--json` field exits 1 the way gh's "Unknown JSON field" does, and an unemulated subcommand exits
1, so a spec cannot pass against a query the real gh would answer differently.

Supported: `auth status`, `api graphql` (the enterprise query, both pages), `issue list`,
`pr view`, `label create`.

A pull request record may carry a `sequence` array. Each `pr view` call shifts the first entry off
it and merges it over the record, so a spec can watch a pull request move from pending to green
across polls the way a real one does.

| Variable | Effect |
| --- | --- |
| `FT_GH_FIXTURE_DIR` | Directory holding `issues.json` and `enterprise-mode` |
| `FT_GH_FIXTURE_FAIL` | Every call fails |

`enterprise-mode` picks the answer to the enterprise query: `both` (one enterprise holding
`acme-org` and `acme-tools`), `neither` (only `acme-org`), `paged` (`acme-tools` only on the
second page), `second` (two enterprises, only the second holding both owners), `error` (the query
fails), `empty` (a well-formed answer with no enterprises node).

## `fixtures.sh`

| Function | Produces |
| --- | --- |
| `ft_fixture_run <path> [target] [args-json] [resolved-json]` | One run marker, unfinished |
| `ft_fixture_events <path> <case>` | One `events.jsonl` per `collect.jq` branch: `clean`, `nonzero`, `failure`, `denied`, `deny-error`, `contradiction`, `retried`, `honest`, `status-ok`, `preceding`, `null-agent`, `hook-error`, `no-command`, `args-used`, `mixed` |
| `ft_fixture_transcript <path> [with-report\|no-assistant\|tool-tail\|truncated]` | A session transcript, including one whose last turn is only tool calls and one cut off mid-write |
| `ft_fixture_hook_input <path> <case> [session]` | One hook payload: `post-ok`, `post-bool-code`, `post-fail`, `post-failure`, `post-failure-no-code`, `pre-deny`, `pre-allow`, `pre-other`, `subagent-stop`, `stop`, `malformed` |
| `ft_fixture_installed_plugins <path> <install-dir> [with-skill\|without-skill]` | The shape of `~/.claude/plugins/installed_plugins.json`, version 2, used by both the resolver and the harden preflight |
| `ft_fixture_marketplaces <path> <local-dir> [directory\|github]` | The shape of `~/.claude/plugins/known_marketplaces.json` |
| `ft_fixture_repo <dir> [owner/name] [ssh\|https\|alias\|none]` | A real repository: two commits, two branches, an origin remote (`alias` writes it through an ssh host alias) |
| `ft_fixture_git <dir> <args...>` | git with identity passed per command, so no global config is needed |
| `ft_fixture_enterprise <dir> [mode]` | The answer the gh stub gives to the enterprise query |
| `ft_fixture_issues <path>` | Five issues: two open `field-test` issues carrying a signature the duplicate search must find, one of them holding quotes, and three near misses it must not |
| `ft_fixture_prs <path>` | Nine pull requests, one per arm of `checks.jq` plus merged, closed, and one that goes green on the second poll |
| `ft_fixture_report <path> <case>` | What a field-test report claimed: `accurate`, `wrong`, `unknown` (a word the verifier cannot check), `missing` (a pull request that does not exist) |

## `hook-inputs/no-run.json`

A payload for a session with no field-test run, kept as a file rather than generated so the
cost of the hooks in an ordinary session can be measured from the command line; see the Hooks
section of `plugins/field-test/README.md`.

## `commands/deny.txt` and `commands/allow.txt`

One command per line, on each side of `plugins/field-test/hooks/deny-list.txt`.
`spec/field-test/hook_spec.sh` walks both files: every command in `deny.txt` must be refused and
every command in `allow.txt` must be allowed. `spec/field-test/fixtures_spec.sh` additionally
asserts that every pattern in the deny list is matched by at least one command in `deny.txt`, so a
pattern cannot be narrowed to nothing while the suite stays green.

`spec/field-test/fixtures_spec.sh` asserts the claims the other specs rely on: which branches and
commit subjects a fixture repository has, that the contradiction case really holds an unresolved
failure while the retried case does not, and what the gh stub refuses to answer.

`setup_ft_sandbox` in `spec/spec_helper.sh` wires it together for one example: a temp state
directory holding a live run marker for session `ft-session`, a fake `HOME` with Claude's plugin
registry, the canned enterprise answer, and the stub on `PATH`. Specs replace individual pieces to
build the negative cases.
