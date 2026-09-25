# Issue format

## Title

Use the Conventional Commits form, because the pull request title and the squash commit
come from it: `type(scope): what changes`. Use the imperative, and keep it below 70
characters.

## Body

```markdown
## Why
One or two paragraphs: the problem, where you saw it, and why it is important. Give
evidence (a command, a run ID, a file:line), not adjectives.

## Scope
What changes, as a list. The files or areas. What is out of scope.

## Acceptance
The condition that closes the issue. A person who did not write it can check it.

## References
Related issues by number, ADRs, documents, and upstream links.
```

- Put blockers in the relationship field, not under References.
- A plan key or a milestone note goes in a footer of one line, in italics:
  `_Plan key P0-3. Blockers are recorded as issue dependencies._`

## Type

Read the types that the repository defines:

```bash
gh api graphql -F owner='{owner}' -F repo='{repo}' -f query='query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){issueTypes(first:20){nodes{name description}}}}' --jq '.data.repository.issueTypes.nodes'
```

Choose the type whose description fits. Use the type of the title as a start:

| Title type | Issue type |
| --- | --- |
| `fix` | Bug |
| `feat` | Feature |
| `docs`, `refactor`, `test`, `chore`, `ci` | Task |

Use this table only for the names that the repository defines. A type from the caller has
priority over the table.

`null` means that the repository has no issue types. Then use a label that is already in
`gh label list`, if one fits (for example `bug`, `enhancement` or `documentation`), with
`--label`. Never create a label.
