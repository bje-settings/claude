# Set fields on issues that exist

1. Find the gaps. The caller can name the issues. If not, list the open issues:

   ```bash
   gh issue list --state open --limit 200 --json number,title,milestone,issueType
   ```

   Read the priority of each issue with the read-back query in [priority.md](priority.md).
   A gap is a field with no value.

2. For each gap, propose a value. The type comes from [format.md](format.md), the priority
   from [priority.md](priority.md), and the milestone from [milestone.md](milestone.md).
   Leave a gap open when no value fits. Say why.
3. Show one table (number, title, and each proposed value), and get one confirmation.
4. Apply the type and the milestone:

   ```bash
   gh issue edit <n> --type "<type>" --milestone "<milestone>"
   ```

   Apply the priority with [priority.md](priority.md).
5. Report the table again, with the values that are now set.
