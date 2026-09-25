# Relationships

There are three relationships: blocked by, blocking, and parent (a sub-issue has one
parent). Each one is a field. Put a relationship only in its field, never in the body.

## Find them

Read the titles of the open issues. Then read the body of each issue in the same area:

```bash
gh issue list --state open --limit 200 --json number,title,milestone
gh issue view <n> --json title,body,blockedBy,blocking,parent,subIssues
```

- Blocked by: this issue cannot finish until that issue closes.
- Blocking: that issue cannot finish until this issue closes.
- Parent: this issue is one part of the work that the other issue tracks.

Propose a relationship only when you can say what the dependency is. Do not propose one
only because two issues are in the same area.

## Set them on a new issue

Use `--blocked-by <n,n>`, `--blocking <n,n>` and `--parent <n>` on `gh issue create`.

## Change them on an issue that exists

```bash
gh issue edit <n> --add-blocked-by <n,n> --add-blocking <n,n> --parent <n>
gh issue edit <n> --remove-blocked-by <n,n> --remove-blocking <n,n> --remove-parent
```

Show the change and get a confirmation before you run it.

## Read them back

```bash
gh issue view <n> --json blockedBy,blocking,parent,subIssues
```

Report what the read-back shows, not what you sent.
