---
name: issues
description: >
  File, link and triage GitHub issues with hygiene. Check for duplicates, set
  blocked-by, blocking and parent in their fields, suggest a milestone, set the
  issue type and a priority, and use one issue format. Use whenever you create
  an issue, link issues, or fill in fields on issues that already exist, in any
  repository.
allowed-tools: Bash(gh issue *) Bash(gh api *) Bash(gh label list *) Read AskUserQuestion
user-invocable: false
---

Do the operation the request asks for. Read only the files that its row names.

| Operation | Read |
| --- | --- |
| Create one issue | [create.md](create.md) |
| Create two or more related issues | [batch.md](batch.md) |
| Add or remove blocked-by, blocking or parent on issues that exist | [relationships.md](relationships.md) |
| Set priority, type, labels or milestone on issues that exist | [triage.md](triage.md) |

## Rules for every operation

- Put a relationship in its field, never as prose in the body. A sweep cannot see a
  dependency in text.
- Never create a label. Do not add a label that says the same thing as an issue type
  ([labels.md](labels.md)).
- The caller can give a milestone, priority, type or parent. Use it after you make sure it
  exists. Do not propose a different value.
- Before a write, show the proposal and get a confirmation with `AskUserQuestion`. Skip this
  only when the request already sets every field. A new issue is public.
- After a write, report the issue number, milestone, type, priority and every relationship.
  This is the graph that the issue joined.
- Some repositories have no issue types or no Priority field. Report that, and do not work
  around it.
- Do not add attribution lines, emoji or em-dashes to a title, body or comment.
