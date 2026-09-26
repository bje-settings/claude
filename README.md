# claude

A [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) for the
`bje` enterprise, defined in `.claude-plugin/marketplace.json`.

## Plugins

Each plugin is one domain of work, and you install it on its own. The lists below are an index.
The plugin's own README has the detail, including the scripts the skills and hooks run.

### [`gh`](plugins/gh)

> Git and GitHub workflow.

<table>
  <tr>
    <th scope="row">Skills</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/gh#ghsync"><code>/gh:sync</code></a>: move a checkout to its default branch, fast-forward it, and prune branches and worktrees whose work has landed. <em>Scope: <code>cwd</code> can be a single repo or a directory of repo subdirs.</em></li>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/gh#ghshepherd"><code>/gh:shepherd</code></a>: merge every auto-merge-enabled PR one at a time, optionally by one label, then rebase and wait on CI between merges. <em>Scope: <code>cwd</code> can be a single repo or a directory of repo subdirs.</em></li>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/gh#ghissues"><code>gh:issues</code></a>: file, link and triage issues. It checks for duplicates, and sets relationships, milestone, type and priority in their fields. <em>Claude starts it when you ask for an issue. It has no slash command.</em></li>
      </ul>
    </td>
  </tr>
  <tr>
    <th scope="row">Agents</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/gh#ghshepherd"><code>shepherd-prs</code></a>: it shepherds one repository's given pull requests serially. <code>/gh:shepherd</code> dispatches it, one per repository, in parallel.</li>
      </ul>
    </td>
  </tr>
  <tr>
    <th scope="row">Hooks</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/gh#session-start-hook">Session start</a>: one status line on start, resume and clear. It counts commits behind, branches to prune, dependency pull requests and Dependabot alerts. A missing git or GitHub CLI gets a line of its own. Never changes a branch, worktree, or working tree.</li>
      </ul>
    </td>
  </tr>
</table>

### [`workstreams`](plugins/workstreams)

> The round primitives are the pieces a round of issue-tracker work runs on. Each piece works on
> its own. The team rebuilds this plugin from scratch, under
> [#111](https://github.com/bje-settings/claude/issues/111). The sweep, the review loop, the
> stream, and the question phase are the first four of five primitives. The orchestrator
> ([#134](https://github.com/bje-settings/claude/issues/134)) is next.

<table>
  <tr>
    <th scope="row">Skills</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamssweep"><code>/workstreams:sweep</code></a>: find what a round could start on. It reports the unblocked set, the tier one issue behind it, and the rest with their open blockers. Then it reads the issue bodies and the decision records. It maps the files each issue touches, and sizes each one. Then it sequences them into parallel streams, a stack, or one pull request. <em>Scope: the repository <code>gh</code> resolves from <code>cwd</code>.</em></li>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsreview"><code>/workstreams:review</code></a>: review one draft pull request through to done. It runs the <code>pr-review-toolkit</code> reviewers over the pull request's own diff. It verifies every finding and every rejection against the code. It applies what holds, then pushes and waits for CI. It does this in at most two rounds. Then it checks the title and body against the final diff. <em>Scope: one pull request, in its own worktree.</em></li>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsstream"><code>/workstreams:stream</code></a>: build one issue, or one stack of them, in one worktree. It writes each layer's brief from the template, and dispatches one sized agent per layer. It opens a draft pull request per layer. It hands each layer to the review loop before it writes the next. <em>Scope: one worktree, one branch per layer.</em></li>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsquestion"><code>/workstreams:question</code></a>: turn a sweep report into an approved plan. It explores every open item before it asks. It asks one question at a time, with a recommendation and the argument against it. It records the rulings that are cheap to reverse instead. It enters plan mode itself. Then it posts the plan comment on every issue in the round, once the human approves it. <em>Scope: the round the sweep named.</em></li>
      </ul>
    </td>
  </tr>
  <tr>
    <th scope="row">Agents</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsstream"><code>stream</code></a>: builds one layer from one brief. <code>/workstreams:stream</code> dispatches it, with the model chosen per call. Effort is the session's own.</li>
      </ul>
    </td>
  </tr>
  <tr>
    <th scope="row">Hooks</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#the-guard-hook">Pre tool use</a>: refuses a background command, and refuses <code>git checkout</code> with a pathspec or <code>git restore</code>, on a tree with uncommitted work. It does this to subagents only. The main conversation is never denied.</li>
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
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/mermaid#mermaidview"><code>/mermaid:view</code></a>: share a mermaid.live or mermaid.ink preview link, built by a script rather than by hand. Do this whenever a Mermaid diagram is written, edited, or reviewed.</li>
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

### [`typescript7-lsp`](plugins/typescript7-lsp)

> The TypeScript 7 language server.

<table>
  <tr>
    <th scope="row">LSP servers</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/typescript7-lsp"><code>typescript7</code></a>: TypeScript 7's native language server from the project's <code>node_modules/typescript</code>. It replaces <code>typescript-lsp@claude-plugins-official</code>.</li>
      </ul>
    </td>
  </tr>
</table>

## Contributing

Run `pnpm test` for the test suite. See [CONTRIBUTING.md](CONTRIBUTING.md) for the rest, and for
how to install the marketplace locally.
