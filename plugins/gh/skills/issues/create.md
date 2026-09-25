# Create one issue

1. Look for a duplicate. Search open and closed issues for the key words of the title.
   Also search for each file path that the issue names:

   ```bash
   gh issue list --search "<words>" --state all --limit 20 --json number,title,state
   ```

   If an issue is similar, name it and propose a comment on it with the new context. Do
   not create the issue. Create it only when the user says that it is different.

2. Write the title and body, and choose the type ([format.md](format.md)).
3. Choose the labels ([labels.md](labels.md)).
4. Find the relationships ([relationships.md](relationships.md)).
5. Find the milestone ([milestone.md](milestone.md)).
6. Choose the priority ([priority.md](priority.md)).
7. Confirm the proposal: title, type, labels, milestone, priority, relationships and body.
8. Create the issue. Send the body on stdin. Leave out each flag that has no value:

   ```bash
   gh issue create --title "<title>" --body-file - --type "<type>" --label "<label,label>" --milestone "<milestone>" --blocked-by <n,n> --blocking <n,n> --parent <n> <<'EOF'
   <body>
   EOF
   ```

9. Set the priority on the new issue ([priority.md](priority.md)).
10. Report the number and the values from the read-back.
