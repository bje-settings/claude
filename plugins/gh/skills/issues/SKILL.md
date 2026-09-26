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
allowed-tools: Bash(gh issue list *) Bash(gh issue view *) Bash(gh issue create *) Bash(gh issue edit *) Bash(gh label list *) Bash(gh api graphql *) Bash(gh api repos/*/milestones *) Read
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
has a different owner than the target.

## Rules for every operation

- Put a relationship in its field, never as text in a body or a comment.
- Never create a label.
- Do not ask for confirmation, in the main session or in a subagent. The caller decided to
  write when it started the skill.
- The caller can give a milestone, priority, type, label, parent, blocked-by or blocking.
  If it does not exist, do not create it. Write without it, and name it on a `Not set:` line
  in the report.
- After a write, read back the issue and report the number, milestone, type, labels,
  priority and every relationship. Give each value that you replaced on a `Replaced:` line.

  ```bash
  gh issue view <n> --json number,title,milestone,issueType,labels,blockedBy,blocking,parent
  ```

- If a write fails, do not run it again. Read back, and report what is set and what is not.
  A failed `gh issue create` can still create the issue: search for its title first. In a
  batch, stop at the first failure.
- The commands use the repository of the working directory. For a different repository,
  add `--repo <owner>/<name>` to each `gh issue` command. Also put its owner and name in
  place of `{owner}` and `{repo}`.
- If `gh` gives `unknown flag` for a flag such as `--type` or `--blocked-by`, say that the
  skill needs gh 2.94 or later, and stop.
- Do not add attribution lines, emoji or em-dashes to a title, body or comment.
