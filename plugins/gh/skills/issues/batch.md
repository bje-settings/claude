# Create two or more related issues

1. Do the duplicate check of [create.md](create.md) step 1 for each issue. Take a
   duplicate out of the batch, and report it with its comment. Continue with the other
   issues.
2. If no issue is left, stop. If one is left, do [create.md](create.md) for it. If two or
   more are left, choose one milestone for them ([milestone.md](milestone.md)).
3. Do [create.md](create.md) steps 2 to 6 for each issue. Find the relationships in the
   batch and to other open issues.
4. Create the milestone first, if it is new. Then create the issues in dependency order: a
   parent before its sub-issues, and a blocker before the issue that it blocks.
5. Use the command of [create.md](create.md) step 7. Inside the batch, set each link from
   the later issue, with `--blocked-by` and `--parent`. The earlier issue does not exist yet
   for `--blocking`.
6. Set the priority on each new issue ([priority.md](priority.md)).
7. Report the batch as one table from the read-back: number, title, type, labels, priority
   and relationships. Put the milestone above the table, with `(new)` if you created it.
