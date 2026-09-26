# Create one issue

1. Look for a duplicate. Search open and closed issues for the key words of the title.
   Also search for each file path that the issue names:

   ```bash
   gh issue list --search "<words>" --state all --limit 20 --json number,title,state
   ```

   An issue is the same work when its Acceptance would also close the new issue. A closed
   issue that was completed is not the same work: put it under References. If an issue is
   the same work, and the caller did not say that the issue is different, create nothing.
   Report the duplicate and a comment with the new context, say that the comment is not
   posted, and stop.

2. Write the title and body, and choose the type ([format.md](format.md)).
3. Choose the labels ([labels.md](labels.md)).
4. Find the relationships ([relationships.md](relationships.md)).
5. Find the milestone ([milestone.md](milestone.md)).
6. Choose the priority ([priority.md](priority.md)).
7. Create the issue. Send the body on stdin. Leave out each flag that has no value:

   ```bash
   gh issue create --title "<title>" --body-file - --type "<type>" --label "<label,label>" --milestone "<milestone>" --blocked-by <n,n> --blocking <n,n> --parent <n> <<'EOF'
   <body>
   EOF
   ```

8. Set the priority on the new issue ([priority.md](priority.md)).
