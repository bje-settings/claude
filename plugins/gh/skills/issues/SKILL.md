---
name: issues
description: >
  Files, links and triages GitHub issues. Checks for duplicates, puts blocked-by,
  blocking and parent in their fields, and sets the milestone, issue type,
  labels and priority, in one issue format. Use for all work that creates or
  changes an issue, in any repository: file, open, log or track a bug, feature,
  task, ticket or follow-up; split work into sub-issues; mark an issue as
  blocked by, blocking or part of another; add an issue to a milestone; set or
  review priority, type or labels; move a dependency from an issue body to its
  field. Also use it when work on an issue finds a follow-up or a dependency,
  and when another skill or agent creates issues.
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

Also read [cross-org.md](cross-org.md) for create, batch and triage if a source repository
has a different owner than the target. Read it before the duplicate check.

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
