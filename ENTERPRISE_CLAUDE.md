# @bje: bje Enterprise

Repositories for the **bje** GitHub enterprise. It consolidates several personal orgs, so it
manages policy and automation once. Not an EMU. `~/Code/CLAUDE.md` covers credentials and
directory conventions.

## Orgs

| Org directory          | Notes                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `@bje-settings/`       | Enterprise configuration and Claude plugin marketplace (`claude`, `containers`, `github`, `terraform`) |
| `@bje-sync-providers/` | `bje-sync` providers (`github`, `receiver`, `vercel`)                                           |
| `@bje-co/`             | Primary org; anything on the bje.co domain (`blocks`, `bje.co`, `cm`, `.github`)                |
| `@bje-web/`            | Web sites with no other org home (no repos yet)                                                 |
| `@bje-apps/`           | Standalone apps and tools (no repos yet)                                                        |
| `@bje-devices/`        | Home automation and hardware (no repos yet)                                                     |
| `@tacoma-fyi/`         | Tacoma community sites (no repos yet)                                                           |
| `@bje-actions/`        | Public reusable Actions/workflows (`conflict-label`)                                            |
| `@bork-ltd/`           | `shippo-packing-slips`                                                                          |
| `@arsenalamerica/`     | Arsenal America; its `.envrc` adds `VERCEL_TEAM_ID` (stowed from `dotfiles-private`)            |

A `bje-bots` org is planned, but does not exist yet. `REPO-MIGRATION.md` maps which
`@brianespinosa` repos move to which org. When a repo transfers, move the local checkout to
`@bje/@<org>/`.

## GitHub settings

Change enterprise and org GitHub settings in the GitHub UI. `@bje-settings/terraform` manages no
setting. Do not add modules to it.

`bje-sync` will likely replace the personal `brianespinosa/settings` probot config (providers in
`bje-sync-providers`).

## Enterprise rulesets

Three enterprise-level rulesets apply to every repo in every org.

| Ruleset (id)              | Effect                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Protect main (21295778)   | Default branch: no deletion or force push; PR required (0 approvals; merge/squash/rebase all allowed) |
| Code Coverage (21882789)  | 95% minimum code coverage, no max-drop limit                                                          |
| Conflict label (22057296) | Requires the `bje-actions/conflict-label` workflow on every PR; no bypass                             |

Orgs and repos layer more rulesets on top (e.g. `arsenalamerica/app` adds required status checks
and a required Preview deployment).

Any repo moved into this enterprise must update its CI to share coverage. The Code Coverage
ruleset applies to every repo.
