# Relationships

There are three relationships: blocked by, blocking, and parent (a sub-issue has one
parent). Each one is a field.

Text such as "blocked by #n", "depends on #n", "after #n", "blocks #n", "part of #n" or a
"Blockers" list is a dependency in text. Put it in the field. A comment can give the
reason for a relationship, but only after the field is set.

## Find them

Read the titles of the open issues. Then read the body and comments of each issue in the
same area:

```bash
gh issue list --state open --limit 200 --json number,title,milestone
gh issue view <n> --json title,body,comments,blockedBy,blocking,parent,subIssues
```

- Blocked by: this issue cannot finish until that issue closes.
- Blocking: that issue cannot finish until this issue closes.
- Parent: this issue is one part of the work that the other issue tracks.

Set a relationship only when you can say what the dependency is. Do not set one
only because two issues are in the same area.

## Set them on a new issue

Use `--blocked-by <n,n>`, `--blocking <n,n>` and `--parent <n>` on `gh issue create`.

## Change them on an issue that exists

Run:

```bash
gh issue edit <n> --add-blocked-by <n,n> --add-blocking <n,n> --parent <n>
gh issue edit <n> --remove-blocked-by <n,n> --remove-blocking <n,n> --remove-parent
```

`--parent` replaces the parent that the issue has. If the issue has a different parent,
replace it only when the request says to.

## Move a dependency from text to a field

A body or a comment can give a dependency in text. Set the field. For a body, also remove
the text. Remove only the dependency text, keep every other line, and give the removed text
in the report:

```bash
gh issue edit <n> --add-blocked-by <n>
gh issue edit <n> --body-file - <<'EOF'
<body without the dependency text>
EOF
```

Do not edit a comment. Say which comment gave the dependency.

## Read them back

```bash
gh issue view <n> --json blockedBy,blocking,parent,subIssues
```

Report what the read-back shows, not what you sent.
