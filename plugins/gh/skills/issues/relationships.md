# Relationships

There are three relationships: blocked by, blocking, and parent (a sub-issue has one
parent). Each one is a field. Put a relationship only in its field.

Do not write a dependency as text in a body or a comment: "blocked by #n", "depends on
#n", "after #n", "blocks #n", "part of #n" or a "Blockers" list. A sweep reads the fields,
and it cannot see text. A comment can give the reason for a relationship, but only after
the field is set.

## Find them

Read the titles of the open issues. Then read the body of each issue in the same area:

```bash
gh issue list --state open --limit 200 --json number,title,milestone
gh issue view <n> --json title,body,comments,blockedBy,blocking,parent,subIssues
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

## Move a dependency from text to a field

When you read an issue and its body or a comment gives a dependency as text, propose that
you set the field. Also propose that you remove the text from the body. Do both only after
the user confirms:

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
