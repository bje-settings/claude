---
name: issues
description: >
  File, link and triage GitHub issues with hygiene. Check for duplicates, set
  blocked-by, blocking and parent in their fields, suggest a milestone, set the
  issue type and a priority, and use one issue format. Use whenever you create
  an issue, link issues, or fill in fields on issues that already exist, in any
  repository.
allowed-tools: Bash(gh issue list *) Bash(gh issue view *) Bash(gh issue create *) Bash(gh issue edit *) Bash(gh label list *) Bash(gh api graphql *) Bash(gh api repos/*/milestones *) Read AskUserQuestion
user-invocable: false
---

Do the operation that the request asks for. Read all of the files in its row, and no others.

| Operation | Read |
| --- | --- |
| Create one issue | [create.md](create.md), [format.md](format.md), [labels.md](labels.md), [relationships.md](relationships.md), [milestone.md](milestone.md), [priority.md](priority.md) |
| Create two or more related issues | [batch.md](batch.md), [create.md](create.md), [format.md](format.md), [labels.md](labels.md), [relationships.md](relationships.md), [milestone.md](milestone.md), [priority.md](priority.md) |
| Add or remove blocked-by, blocking or parent on issues that exist | [relationships.md](relationships.md) |
| Set priority, type, labels, milestone or relationships on issues that exist | [triage.md](triage.md), [format.md](format.md), [labels.md](labels.md), [relationships.md](relationships.md), [milestone.md](milestone.md), [priority.md](priority.md) |

## Rules for every operation

- Put a relationship in its field, never as text in a body or a comment. A sweep cannot see
  a dependency in text.
- Never create a label. Do not add a label that says the same thing as an issue type.
- The caller can give a milestone, priority, type or parent. Make sure that it exists, and
  then use it. If it does not exist, say so and ask. Do not create it.
- Confirm before each write: show the proposal and ask with `AskUserQuestion`. Do not ask
  when the request already sets every value.
- A subagent has no `AskUserQuestion`. There, write only when the request sets every value.
  Otherwise, return the proposal to the caller and write nothing.
- After a write, report the issue number, milestone, type, labels, priority and every
  relationship.
- The commands use the repository of the working directory. For a different repository,
  add `--repo <owner>/<name>` to each `gh issue` command. Also put its owner and name in
  place of `{owner}` and `{repo}`.
- If `gh` refuses a flag such as `--type` or `--blocked-by`, say that the skill needs gh
  2.94 or later, and stop.
- Do not add attribution lines, emoji or em-dashes to a title, body or comment.
