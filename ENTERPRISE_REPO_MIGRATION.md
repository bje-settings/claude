# Repo Migration Map

Where every repo owned by the personal `brianespinosa` account will end up. This is a plan only.
Nothing listed here has moved, unless it is marked done.

This file is symlinked to `~/Code/@bje/REPO-MIGRATION.md`. Update the row when a repo moves, and
move the local checkout from `~/Code/@brianespinosa/<repo>` to `~/Code/@bje/@<org>/<repo>`.

## Prerequisites for every move

- **Full coverage.** The enterprise Code Coverage ruleset requires 95% on every repo, so a repo
  reaches full coverage before it transfers.
- **Docs-only repos are untested against the ruleset.** Nobody knows yet whether the ruleset
  blocks or passes a repo that never uploads a coverage report. Move `speaking-contexts` first,
  and confirm the result before you move `home-assistant-config` or `3d-printer-profiles`.
- **Update references.** GitHub redirects transferred repos, but the redirect breaks if a repo of
  the same name is later created under `brianespinosa`. Update `uses:` refs, `_extends`, remotes,
  and doc links instead. Do not rely on the redirect.

## Orgs

| Org                  | Status  | Purpose                                                             |
| -------------------- | ------- | ------------------------------------------------------------------- |
| `bje-co`             | exists  | Primary org; anything served from the bje.co domain                 |
| `bje-web`            | exists  | Web sites that have no other org home                               |
| `bje-apps`           | exists  | Standalone apps and tools                                           |
| `bje-devices`        | exists  | Home automation and hardware                                        |
| `tacoma-fyi`         | exists  | Tacoma community sites                                              |
| `bje-actions`        | exists  | Public reusable GitHub Actions and workflows                        |
| `bork-ltd`           | exists  | Bork Tools 3D printing business                                     |
| `bje-settings`       | exists  | Enterprise configuration, Claude marketplace                        |
| `bje-sync-providers` | exists  | `bje-sync` provider repos                                           |
| `arsenalamerica`     | exists  | Arsenal America                                                     |
| `bje-bots`           | planned | Not created yet. Bots (approval bot), possibly `bje-sync` itself    |

## Mapping

| Repo                            | Destination                  | Notes                                                                   |
| -------------------------------- | ---------------------------- | ----------------------------------------------------------------------- |
| `career`                        | `bje-co`                     | career.bje.co                                                           |
| `resume`                        | `bje-co`                     | resume.bje.co                                                           |
| `portable-hooks`                | `bje-co`                     | portable-hooks.bje.co                                                   |
| `speaking-contexts`             | `bje-co`                     | First docs-only move; tests the coverage ruleset                        |
| `kandb.co`                      | `bje-web`                    |                                                                         |
| `zacharyscorner`                | `bje-web`                    |                                                                         |
| `MenuRemote`                    | `bje-apps`                   |                                                                         |
| `Theme`                         | `bje-apps`                   | FigJam widget                                                           |
| `google-calendar-health-report` | `bje-apps`                   | Apps Script with Slack alerts                                           |
| `home-assistant-config`         | `bje-devices`                | Docs-only; see prerequisites                                            |
| `vu1-claude-token-usage`        | `bje-devices`                |                                                                         |
| `tacoma.fyi`                    | `tacoma-fyi`                 |                                                                         |
| `tacomawedge`                   | `tacoma-fyi`                 |                                                                         |
| `release-action`                | `bje-actions`                | Move with its consumers; update `uses:` refs                            |
| `checkout-setup-node-install`   | `bje-actions`                |                                                                         |
| `job-root-cache`                | `bje-actions`                |                                                                         |
| `next-build-cache`              | `bje-actions`                |                                                                         |
| `create-issue-for-cve`          | `bje-actions`                | Private today; becomes public                                           |
| `bork`                          | `bork-ltd`                   | Stays private                                                           |
| `prusa-connect-auto-ready`      | `bork-ltd`, archived (done)  | No Vercel deploy after 2026-01-03                                       |
| `3d-printer-profiles`           | `bork-ltd`                   | Docs-only; see prerequisites                                            |
| `skills`                        | `bje-settings/claude`        | Merge plugins into the bje marketplace, then archive                    |
| `settings`                      | archive                      | Likely replaced by `bje-sync`                                           |
| `.vscode`                       | archive                      | Git submodule syncing is in doubt                                       |
| `defiance`                      | archive                      | README, LICENSE, and package.json only                                  |
| `filter`                        | archive                      | Prototype; last push 2022                                               |
| `claude-workflows`              | archived (done)              | Personal job-search prompts                                             |
| `PuckJS-TV-mount-remote`        | archived (done)              | Last push 2021                                                          |
| `user-github-workflows`         | stays on user, split later   | See below                                                               |
| `brianespinosa`                 | stays on user                | Profile README must live on the user account                            |
| `dotfiles`                      | stays on user                |                                                                         |
| `dotfiles-private`              | stays on user                |                                                                         |

### Also stays on user

- **Forks:** `codehike`, `node-stl`, `react-textfit`, `Semantic-UI-React`, `setup-node`, `vercel`,
  `vercel-doorman`, `ionic2-sass` (archived).
- **Already archived:** `actions`, `bjeco`, `configs`, `craft-fitbit`, `craft-spotify`,
  `hilltop-rats`, `nextpose`, `portable-hooks-example`.

## Related changes outside the repo moves

- **`bje-settings/terraform`**: `bje-sync` will likely replace it, along with `settings`.
- **`user-github-workflows`** stays on the user account for now. Both jobs resolve their scope from
  `github.repository_owner`, so they cannot transfer as-is. The later split:
  - Scheduled workflows (Dependabot rebase and similar) go to `bje-settings/github`.
  - The approval bot (`THUMBS_UP_BOT`) goes to `bje-bots`.
  - Notification tidy is per-user. Decide whether it stays on the user account.
