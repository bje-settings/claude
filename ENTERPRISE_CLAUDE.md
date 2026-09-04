# @bje - BJE Enterprise

This directory contains repositories for the **bje** GitHub enterprise (billing contact `b@bje.co`).
It is a personal enterprise used to consolidate several orgs and projects under one roof so
management, policy, and automation are shared across many repositories.

Unlike `@momentive_emu`, this enterprise is **not** an EMU with a separate managed user. Membership
is held by the normal personal `brianespinosa` account, so credentials are inherited from the root
`~/Code/.envrc` and no enterprise-level `.envrc` exists here.

## Orgs

| Org directory      | GitHub org       | Notes                                                      |
| ------------------ | ---------------- | ---------------------------------------------------------- |
| `@bje-settings/`   | `bje-settings`   | Enterprise and org configuration as code (`terraform`)     |
| `@bje-co/`         | `bje-co`         | Primary org (`blocks`, `bje.co`, `cm`, `.github`)          |
| `@bje-actions/`    | `bje-actions`    | Public reusable Actions/workflows (`conflict-label`)      |
| `@bork-ltd/`       | `bork-ltd`       | `shippo-packing-slips`                                     |
| `@arsenalamerica/` | `arsenalamerica` | Arsenal America; has its own `.envrc` for `VERCEL_TEAM_ID` |

## Directory Structure

Org directories use the `@` prefix and match the GitHub org login exactly, the same convention as
`@momentive_emu`. When cloning a repo for org `bje-co`, the target path is
`@bje/@bje-co/<repo-name>`.

Orgs with no repos still get a directory so the enterprise layout stays complete and clone targets
are obvious.

## Claude plugins

`@bje-settings/claude` is where Claude Code plugins for this enterprise are built and shared, via
a plugin marketplace (`.claude-plugin/marketplace.json`) -- primarily for `@bje` repos, but
sometimes shared outside the enterprise too. See its own `CLAUDE.md` for the marketplace and
plugin layout.

## Migration from `@brianespinosa`

Most repos currently under `~/Code/@brianespinosa/` (the personal user namespace) are expected to
move into an org inside this enterprise over time. Forks are the likely exception -- they stay on
the personal user account. When a repo is transferred, move the local checkout to the matching
`@bje/@<org>/` directory rather than leaving it under `@brianespinosa/`.

## Configuration as code

`@bje-settings/terraform` manages enterprise and org GitHub settings with the
`integrations/github` Terraform provider, state in HCP Terraform, applies in GitHub
Actions. Org settings, Actions policy, custom properties, and org rulesets are managed
there rather than through the GitHub UI. `bje-co` is not yet covered.

## Enterprise rulesets

Three rulesets defined at the enterprise level apply to repos in every org. They are **not**
managed in terraform today (the `org-baseline` module defines an optional org-level
`default_branch_ruleset`, disabled by default, but nothing covers enterprise rulesets). The
first two were created in the GitHub UI; Conflict label was created from the committed
`rulesets/enterprise-conflict-label.json` in `bje-actions/conflict-label`.

| Ruleset (id)                                     | Target | Enforcement | Effect                                                                                                               |
| ------------------------------------------------ | ------ | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| Protect main (21295778)                          | branch | active      | Blocks deletion and force pushes on the default branch; requires a PR (0 approvals; merge/squash/rebase all allowed) |
| Code Coverage (21882789)                         | branch | active      | Requires 95% minimum code coverage, no max-drop limit                                                                 |
| Conflict label (22057296)                        | branch | active      | Requires the `bje-actions/conflict-label` workflow on every PR to keep a `conflicting` label in sync; no bypass       |

Orgs and repos layer additional rulesets on top (e.g. the `bje-co` org ruleset "Protect default
branch" adds copilot code review; `arsenalamerica/app` repo rulesets add required status checks
and a required Preview deployment).

Any repo moved into this enterprise must have its CI updated to share coverage, since the Code
Coverage ruleset applies to every repo. Code quality is already enabled for all repos by default
in every org.

## GitHub Credentials

Inherited from `~/Code/.envrc` (personal `brianespinosa` account, `~/.config/gh/personal`). No
per-enterprise override. `@arsenalamerica/.envrc` uses `source_up` and only adds Vercel config; it is
stowed from `@brianespinosa/dotfiles-private`.
