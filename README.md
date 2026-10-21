# claude

A [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) for the
`bje` enterprise, defined in `.claude-plugin/marketplace.json`.

## Install

Add the marketplace, then install each plugin you want:

```text
/plugin marketplace add bje-settings/claude
/plugin install <plugin>@bje
```

`/plugin install` opens the plugin's details in the `/plugin` panel, where you install it.
`workstreams` needs more tools; its [Requirements](plugins/workstreams#requirements) list them.

## Plugins

Each plugin is one domain of work, and you install it on its own. The lists below are an index.
The plugin's own README has the detail, with the scripts the skills and hooks run.

### [`gh`](plugins/gh)

> Git and GitHub workflow.

<table>
  <tr>
    <th scope="row">Skills</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/gh#ghsync"><code>/gh:sync</code></a>: move a checkout to its default branch, fast-forward it, and prune branches and worktrees whose work has landed. <em>Scope: <code>cwd</code> can be a single repo or a directory of repo subdirs.</em></li>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/gh#ghissues"><code>gh:issues</code></a>: file, link and triage issues. It checks for duplicates, and sets relationships, milestone, type and priority in their fields. <em>Claude starts it when you ask for an issue. It has no slash command.</em></li>
      </ul>
    </td>
  </tr>
  <tr>
    <th scope="row">Hooks</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/gh#session-start-hook">Session start</a>: one status line on start, resume, clear and compact. It shows commits behind, branches to prune, dependency pull requests and Dependabot alerts. Each kind of problem gets a line of its own, such as a failed fetch or a missing git. It fetches, but never changes a branch, worktree, or working tree.</li>
      </ul>
    </td>
  </tr>
</table>

### [`shepherd`](plugins/shepherd)

> Pull request merges.

<table>
  <tr>
    <th scope="row">Skills</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/shepherd#shepherdmerge"><code>/shepherd:merge</code></a>: merge every auto-merge-enabled PR one at a time, and each stack once every layer is ready, optionally by one label, then rebase and wait on CI between merges. <em>Scope: <code>cwd</code> can be a single repo or a directory of repo subdirs.</em></li>
      </ul>
    </td>
  </tr>
  <tr>
    <th scope="row">Agents</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/shepherd#shepherdmerge"><code>shepherd-prs</code></a>: it shepherds one repository's given pull requests serially. <code>/shepherd:merge</code> dispatches it, one per repository, in parallel.</li>
      </ul>
    </td>
  </tr>
  <tr>
    <th scope="row">Hooks</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/shepherd#session-start-hook">Session start</a>: checks for git, the GitHub CLI and the <code>gh stack</code> extension when a session starts, resumes, clears or compacts. It writes nothing when all are present. An absent tool gets a line of its own. The extension gets a line only when both tools are present.</li>
      </ul>
    </td>
  </tr>
</table>

### [`workstreams`](plugins/workstreams)

> Round primitives for issue-tracker work. `/workstreams:start` is the one entry that you run.
> Claude starts the other four.

<table>
  <tr>
    <th scope="row">Skills</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsstart"><code>/workstreams:start</code></a>: run a round, or continue one. It invokes the sweep and the question phase, then builds a layer at a time and reviews each to done. It arms a watch with the Monitor tool, which wakes it on each new head, required check and merge. On each wake it checks each new head and looks for a collision between streams. At the round end it reports the merge sequence and the cost. Nothing merges. With <code>pr &lt;n&gt;</code>, it takes one pull request through review to done. <em>Scope: the repository <code>gh</code> resolves from <code>cwd</code>.</em></li>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamssweep"><code>workstreams:sweep</code></a>: find what a round could start on. It reports the unblocked set and the number of blocked issues. Then it reads the issue bodies and the decision records. It maps the files each issue touches, and sizes each one. Then it sequences them into parallel streams, a stack, or one pull request. <em>Claude starts it for <code>/workstreams:start</code>. It has no slash command. Scope: the repository <code>gh</code> resolves from <code>cwd</code>.</em></li>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsreview"><code>workstreams:review</code></a>: take one step of the review loop on one draft pull request. A round runs the <code>pr-review-toolkit</code> reviewers over the pull request's own diff. It verifies every finding and every rejection against the code. It applies what holds, then pushes. It reads CI once and never waits for it. The loop runs at most two rounds. Then it checks the title and body against the final diff. <em>Claude starts it for <code>/workstreams:start</code>. It has no slash command. Scope: one pull request, in its own worktree.</em></li>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsstream"><code>workstreams:stream</code></a>: build one issue, or one stack of them, in one worktree, a step for each call. It writes each layer's brief from the template, and dispatches one sized agent per layer. The layer opens its own draft pull request. It reads each layer's return. <em>Claude starts it for <code>/workstreams:start</code>. It has no slash command. Scope: one worktree, one branch per layer.</em></li>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsquestion"><code>workstreams:question</code></a>: turn a sweep report into an approved plan. It explores every open item before it asks. It asks one question at a time, with a recommendation and the argument against it. It records the rulings that are cheap to reverse instead. It enters plan mode itself. Then it posts the plan comment on every issue in the round, once the human approves it. <em>Claude starts it for <code>/workstreams:start</code>. It has no slash command. Scope: the round the sweep named.</em></li>
      </ul>
    </td>
  </tr>
  <tr>
    <th scope="row">Agents</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsstream"><code>stream</code></a>: builds one layer from one brief. The <code>workstreams:stream</code> skill dispatches it, with the model chosen per call. Effort is the session's own.</li>
      </ul>
    </td>
  </tr>
  <tr>
    <th scope="row">Hooks</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#the-guard-hook">Pre tool use</a>: refuses a background command, a git command that would overwrite uncommitted work in a tracked file, and a <code>vitest</code> or <code>pnpm test</code> run while one already runs in the same worktree. It does this to subagents only. The main conversation is never denied.</li>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#sessionstart-hook">Session start</a>: checks the plugin's requirements when a session starts, resumes, clears or compacts. It writes nothing when all are present. It writes one line for each absent item.</li>
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
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/mermaid#mermaidview"><code>/mermaid:view</code></a>: share a mermaid.live or mermaid.ink preview link, built by a script rather than by hand. Claude shares it whenever a Mermaid diagram is written, edited, or reviewed.</li>
      </ul>
    </td>
  </tr>
</table>

### [`audit`](plugins/audit)

> Repository context-file auditing.

<table>
  <tr>
    <th scope="row">Skills</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/audit#auditcontext"><code>/audit:context</code></a>: audit a checkout's <code>CLAUDE.md</code>, <code>README.md</code>, and <code>.claude/**/*.md</code> files. It finds three problems: references that no longer resolve, statements whose named condition has ended, and duplicated claims. It runs fully without a key. Repository text reaches TypeSafe only when <code>TYPESAFE_API_KEY</code> is set.</li>
      </ul>
    </td>
  </tr>
</table>

## Contributing

Run `pnpm test` for the test suite. See [CONTRIBUTING.md](CONTRIBUTING.md) for the rest, and for
how to install the marketplace locally.
