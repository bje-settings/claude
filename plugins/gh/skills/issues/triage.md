# Set fields on issues that exist

1. Find the issues. The caller can name them. If not, list the open issues:

   ```bash
   gh issue list --state open --limit 200 --json number,title,body,comments,milestone,issueType,labels
   ```

2. Read the Priority field once ([priority.md](priority.md), "Read the field"). If the
   field exists, read the priority of each issue ("Read it back").
3. Find the gaps. A gap is one of these:
   - a type, milestone or priority with no value
   - no type label in a repository with no issue types ([labels.md](labels.md))
   - a label that says the same thing as a type ([labels.md](labels.md))
   - a dependency in text in a body or a comment ([relationships.md](relationships.md))

   If there is no gap, say so and stop.

4. Propose a value for each gap, from [format.md](format.md), [labels.md](labels.md),
   [milestone.md](milestone.md), [priority.md](priority.md) and
   [relationships.md](relationships.md). If no value fits, leave the gap open and say why.
5. Confirm all of the values as one table: number, title, and each proposed value.
6. Apply the type, labels and milestone. Leave out each flag that has no value. An empty
   `--milestone` removes the milestone that the issue has:

   ```bash
   gh issue edit <n> --type "<type>" --add-label "<label>" --remove-label "<label>" --milestone "<milestone>"
   ```

7. Apply the priority ([priority.md](priority.md)). Move each dependency from text to its
   field ([relationships.md](relationships.md)).
8. Report the table again, with the values from the read-back.
