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

> Issue orchestration: a set of GitHub issues becomes parallel streams run by subagents, each
> ending in a reviewed draft PR. Requires `gh-stack` and `pr-review-toolkit`; see
> [Requirements](https://github.com/bje-settings/claude/tree/main/plugins/workstreams#requirements).

<table>
  <tr>
    <th scope="row">Skills</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsplan-selectors"><code>/workstreams:plan</code></a>: resolve issue selectors, classify each issue as work now, defer, or blocked, group overlapping files into stacks, size each stream, and record the approved plan. Starts nothing.</li>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsrun"><code>/workstreams:run</code></a>: start one subagent per planned stream, check progress on a self-timed cadence, run a review round on every draft, and decide from the diffstat of what that round pushed whether one repeat is due. Then the checks decide. PRs stay drafts.</li>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsreview-pr---worktree-path---base-branch---model-alias"><code>/workstreams:review</code></a>: one review round over one draft PR: <code>review-pr</code> plus the PR's own bot and human threads, every finding verified, the ones that hold applied and replied to. No loop, no state, no wake.</li>
      </ul>
    </td>
  </tr>
  <tr>
    <th scope="row">Agents</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsrun"><code>stream-low</code>, <code>stream-medium</code>, <code>stream-high</code></a>: work one stream through to a draft PR at the effort the plan sized it; dispatched by <code>/workstreams:run</code>.</li>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsreview-pr---worktree-path---base-branch---model-alias"><code>applier</code></a>: applies a list of already-verified review findings to one draft PR, runs the tests, pushes, and refreshes a stale title or body; dispatched by <code>/workstreams:review</code>.</li>
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

<table>
  <tr>
    <th scope="row">Skills</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/field-test#field-testrun-target-args"><code>/field-test:run</code></a>: run a skill or command as a field test, collect what its scripts and subagents actually did, and file one reproducible issue per problem on the repository that owns the plugin under test. Every issue is shown before it is created.</li>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/field-test#field-testharden-pluginskill---targets-repo-path"><code>/field-test:harden</code></a>: run that loop over an ordered list of target repositories, verify each round's report against GitHub, and drive the findings through fix, review, and merge until the skill is clean or a decision needs a person.</li>
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

## Contributing

Run `uv run --locked pytest -n auto --cov` for the whole suite. Every plugin script is Python, so
pytest is the only harness and `uv` the only requirement. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the rest, and for installing the marketplace locally.
