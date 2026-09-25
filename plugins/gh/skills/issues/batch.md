# Create two or more related issues

1. Do the duplicate check of [create.md](create.md) step 1 for each issue. Take a
   duplicate out of the batch, and propose a comment on it. Continue with the other issues.
2. Propose a milestone for the batch ([milestone.md](milestone.md), "Create for a batch").
3. Do [create.md](create.md) steps 2 to 6 for each issue. Find the relationships in the
   batch and to other open issues.
4. Confirm the batch as one table: title, type, labels, priority, blocked by, blocking and
   parent.
5. Create the milestone first, if it is new. Then create the issues in dependency order: a
   parent before its sub-issues, and a blocker before the issue that it blocks.
6. Use the command of [create.md](create.md) step 8. Inside the batch, set each link from
   the later issue, with `--blocked-by` and `--parent`. The earlier issue does not exist yet
   for `--blocking`.
7. Set the priority on each new issue ([priority.md](priority.md)).
8. Report the batch as one table: number, title, type, labels, priority and relationships.
   Put the milestone above the table.
