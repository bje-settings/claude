# claude

A [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) for the
`bje` enterprise, defined in `.claude-plugin/marketplace.json`.

## Plugins

Each plugin is one domain of work and is installed on its own. The lists below are an index;
the plugin's own README has the detail, including the scripts the skills and hooks run.

### [`gh`](plugins/gh)

> Git and GitHub workflow.

<table>
  <tr>
    <th scope="row">Skills</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/gh#ghsync"><code>/gh:sync</code></a>: move a checkout to its default branch, fast-forward it, and prune branches and worktrees whose work has landed. <em>Scope: <code>cwd</code> can be a single repo or a directory of repo subdirs.</em></li>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/gh#ghshepherd"><code>/gh:shepherd</code></a>: merge auto-merge-enabled <code>dependencies</code> PRs one at a time, rebasing and waiting on CI between merges. <em>Scope: <code>cwd</code> can be a single repo or a directory of repo subdirs.</em></li>
      </ul>
    </td>
  </tr>
  <tr>
    <th scope="row">Agents</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/gh#ghshepherd"><code>shepherd-repo</code></a>: shepherds one repository serially; dispatched by <code>/gh:shepherd</code>, one per repo in parallel.</li>
      </ul>
    </td>
  </tr>
  <tr>
    <th scope="row">Hooks</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/gh#session-start-hook">Session start</a>: report-only check on startup that offers <code>/gh:sync</code> when there is something to act on. Never changes a branch, worktree, or working tree.</li>
      </ul>
    </td>
  </tr>
</table>

### [`workstreams`](plugins/workstreams)

> The round primitives: the pieces a round of issue-tracker work is run out of, each usable
> on its own. Being rebuilt from scratch under
> [#111](https://github.com/bje-settings/claude/issues/111); the sweep is the first of the
> five, and the review loop ([#133](https://github.com/bje-settings/claude/issues/133)),
> the stream ([#132](https://github.com/bje-settings/claude/issues/132)), the question
> phase ([#131](https://github.com/bje-settings/claude/issues/131)) and the orchestrator
> ([#134](https://github.com/bje-settings/claude/issues/134)) land after it.

<table>
  <tr>
    <th scope="row">Skills</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamssweep"><code>/workstreams:sweep</code></a>: find what a round could start on. Reports the unblocked set, the tier one issue behind it, and the rest with their open blockers; then reads the bodies and the decision records, maps the files each issue touches, sizes each one, and sequences them into parallel streams, a stack, or one pull request. <em>Scope: the repository <code>gh</code> resolves from <code>cwd</code>.</em></li>
      </ul>
    </td>
  </tr>
</table>

### [`field-test`](plugins/field-test)

> Plugin quality assurance: run a skill under observation, turn what went wrong into issues
> somebody who did not watch the run can reproduce, and keep going until they are fixed. Names
> from a repository outside the plugin's enterprise are redacted before anything is published.
> `/field-test:harden` requires `workstreams` and `pr-review-toolkit`; see
> [Requirements](https://github.com/bje-settings/claude/tree/main/plugins/field-test#requirements).
> `workstreams` is being rebuilt under
> [#111](https://github.com/bje-settings/claude/issues/111): the sweep has landed, and the review
> loop `harden` dispatches to has not, so `/field-test:harden` stays unavailable until
> [#137](https://github.com/bje-settings/claude/issues/137) rebuilds it on the primitives.

<table>
  <tr>
    <th scope="row">Skills</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/field-test#field-testrun-target-args"><code>/field-test:run</code></a>: run a skill or command as a field test, collect what its scripts and subagents actually did, and file one reproducible issue per problem on the repository that owns the plugin under test. Every issue is shown before it is created.</li>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/field-test#field-testharden-pluginskill---targets-repo-path"><code>/field-test:harden</code></a>: run that loop over an ordered list of target repositories, verify each round's report against GitHub, and drive the findings through fix, review, and merge until the skill is clean or a decision needs a person. Unavailable until <a href="https://github.com/bje-settings/claude/issues/137">#137</a> rebuilds it on the <code>workstreams</code> primitives.</li>
      </ul>
    </td>
  </tr>
  <tr>
    <th scope="row">Hooks</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/field-test#hooks">Tool and subagent recording</a>: records every Bash call, subagent report, and refused command while a field test is running. Silent and immediate in any other session.</li>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/field-test#the-deny-list">Deny list</a>: refuses the handful of commands a field test must not let its target run, and records the attempt as the highest-severity finding.</li>
      </ul>
    </td>
  </tr>
</table>

### [`mermaid`](plugins/mermaid)

> Mermaid diagram previews.

<table>
  <tr>
    <th scope="row">Skills</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/mermaid#mermaidview"><code>/mermaid:view</code></a>: share a mermaid.live or mermaid.ink preview link, built by a script rather than by hand, whenever a Mermaid diagram is written, edited, or reviewed.</li>
      </ul>
    </td>
  </tr>
</table>

## Sharing a plugin outside this repo

This repo is internal to the `bje` enterprise, so a team that cannot read it cannot install from
it either. There is no mirroring tool for that today: `publish-plugin.py` and the `/publish` skill
that wrapped it were removed at #128, since this repo is going public once the TypeScript port
finishes, which makes a downstream mirror unnecessary.

`sm-incubator/org-claude` still holds a copy of `gh`, taken before that removal, at version 0.3.0
in a marketplace named `lab`. It stays there, generated and unmaintained, until this repo is
public, at which point that marketplace points here instead.

## Contributing

Run `pnpm test` for the TypeScript suite and `uv run --locked pytest -n auto --cov` for the Python
one, which retires as the port to TypeScript finishes. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the rest, and for installing the marketplace locally.
