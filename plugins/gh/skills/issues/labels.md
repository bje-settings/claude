# Labels

List the labels that the repository has:

```bash
gh label list --limit 1000 --json name,description
```

Use only a label from this list.

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

Use a label only for a thing that the type does not give. Examples are an area
(`documentation`, `accessibility`) and a state (`help wanted`, `good first issue`).

## No issue types

When the repository has no issue types, use the label from the table that fits, if the
repository has it.

## An issue that has a type label

This applies only when the repository defines issue types. An issue can have a label from
the table, with or without a type. If the issue has no type, set the type and remove the
label. If it has a type, remove the label only when the label agrees with the type.
Otherwise keep both, and report the conflict:

```bash
gh issue edit <n> --type "<type>" --remove-label "<label>"
```

Remove the label in the same command that sets the type.
