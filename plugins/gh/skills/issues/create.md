# Create one issue

1. Look for a duplicate. Search open and closed issues for the key words of the title, and
   for each file path that the issue names:

   ```bash
   gh issue list --search "<words>" --state all --limit 20 --json number,title,state
   ```

   If an issue is similar, name it. Propose a comment on it with the new context, and stop.
   Create a new issue only when the user says that it is different.

2. Write the title and body from [format.md](format.md), and choose the type there. Choose
   the labels with [labels.md](labels.md).
3. Find the relationships with [relationships.md](relationships.md).
4. Find the milestone with [milestone.md](milestone.md).
5. Choose the priority with [priority.md](priority.md).
6. Show the proposal: title, type, labels, milestone, priority, relationships, and the body.
   Get a confirmation.
7. Create the issue. Send the body on stdin. Leave out each flag that has no value:

   ```bash
   gh issue create --title "<title>" --body-file - --type "<type>" --label "<label,label>" --milestone "<milestone>" --blocked-by <n,n> --blocking <n,n> --parent <n> <<'EOF'
   <body>
   EOF
   ```

8. Set the priority on the new issue with [priority.md](priority.md).
9. Report the number and the graph.
