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
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/gh#session-start-hook">Session start</a>: one status line on start, resume and clear. It shows commits behind, branches to prune, dependency pull requests and Dependabot alerts. Each kind of problem gets a line of its own, such as a failed fetch or a missing git. Never changes a branch, worktree, or working tree.</li>
      </ul>
    </td>
  </tr>
</table>

### [`workstreams`](plugins/workstreams)

> The round primitives are the pieces a round of issue-tracker work runs on. The team rebuilds
> this plugin from scratch, under [#111](https://github.com/bje-settings/claude/issues/111).
> All five primitives exist. `/workstreams:start`, the orchestrator, is the one entry. The
> sweep, the question phase, the stream, and the review loop are model-only: it invokes them.

<table>
  <tr>
    <th scope="row">Skills</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsstart"><code>/workstreams:start</code></a>: run a round, or continue one. It invokes the sweep and the question phase, then builds a layer at a time and reviews each to done. It arms a watch with the Monitor tool, which wakes it on each new head, required check and merge. On each wake it checks each new head and looks for a collision between streams. At the round end it posts the merge sequence and the cost. Nothing merges. With <code>#&lt;pr&gt;</code>, it takes one pull request through review to done. <em>Scope: the repository <code>gh</code> resolves from <code>cwd</code>.</em></li>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamssweep"><code>/workstreams:sweep</code></a> (model-only): find what a round could start on. It reports the unblocked set, and the rest with their open blockers. Then it reads the issue bodies and the decision records. It maps the files each issue touches, and sizes each one. Then it sequences them into parallel streams, a stack, or one pull request. <em>Scope: the repository <code>gh</code> resolves from <code>cwd</code>.</em></li>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsreview"><code>/workstreams:review</code></a> (model-only): take one step of the review loop on one draft pull request. A round runs the <code>pr-review-toolkit</code> reviewers over the pull request's own diff. It verifies every finding and every rejection against the code. It applies what holds, then pushes and watches CI. The loop runs at most two rounds. Then it checks the title and body against the final diff. <em>Scope: one pull request, in its own worktree.</em></li>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsstream"><code>/workstreams:stream</code></a> (model-only): build one issue, or one stack of them, in one worktree, a step for each call. It writes each layer's brief from the template, and dispatches one sized agent per layer. The layer opens its own draft pull request. It reads each layer's return. <em>Scope: one worktree, one branch per layer.</em></li>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsquestion"><code>/workstreams:question</code></a> (model-only): turn a sweep report into an approved plan. It explores every open item before it asks. It asks one question at a time, with a recommendation and the argument against it. It records the rulings that are cheap to reverse instead. It enters plan mode itself. Then it posts the plan comment on every issue in the round, once the human approves it. <em>Scope: the round the sweep named.</em></li>
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

### [`biome-lsp`](plugins/biome-lsp)

> The Biome language server.

<table>
  <tr>
    <th scope="row">LSP servers</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/biome-lsp"><code>biome</code></a>: Biome's language server from the project's <code>node_modules/@biomejs/biome</code>. It covers <code>.json</code>.</li>
      </ul>
    </td>
  </tr>
</table>

### [`eslint-lsp`](plugins/eslint-lsp)

> The ESLint language server.

<table>
  <tr>
    <th scope="row">LSP servers</th>
    <td>
      <ul>
        <li><a href="https://github.com/bje-settings/claude/tree/main/plugins/eslint-lsp"><code>eslint</code></a>: the VS Code ESLint language server from the project's own ESLint and config. It covers <code>.md</code> and <code>.json</code>.</li>
      </ul>
    </td>
  </tr>
</table>

## Contributing

Run `pnpm test` for the test suite. See [CONTRIBUTING.md](CONTRIBUTING.md) for the rest, and for
how to install the marketplace locally.
