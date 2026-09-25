# Labels

List the labels that the repository has:

```bash
gh label list --limit 100 --json name,description
```

Never create a label. Use only a label from this list.

## Prefer the issue type

An issue type and a label must not say the same thing. When the repository defines issue
types, do not add a label that only gives the kind of work:

| Label | Use this issue type |
| --- | --- |
| `bug` | Bug |
| `enhancement`, `feature` | Feature |
| `task` | Task |

Compare the label description with the type descriptions too. A label with a different name
can still give only the kind of work.

Use a label only for a thing that the type does not give, for example an area
(`documentation`, `accessibility`) or a state (`help wanted`, `good first issue`).

## No issue types

When the repository has no issue types, use the one label from the table that fits, if the
repository has it. Add it with `--label` on `gh issue create` or `--add-label` on
`gh issue edit`.

## An issue that has a type label

An issue can have a label from the table and no type, or both. Propose that you set the
type and remove the label:

```bash
gh issue edit <n> --type "<type>" --remove-label "<label>"
```

Remove the label only after the type is set and the user confirms.
