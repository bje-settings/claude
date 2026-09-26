# An issue in the repository of a different owner

Do these steps before the confirm step: [create.md](create.md) step 7,
[batch.md](batch.md) step 4 or [triage.md](triage.md) step 5. When the request sets every
value, do them before the write.

1. Find the owners:
   - Target: the owner of the repository that gets the issue.
   - Sources: the owner of the working directory's repository, and the owner of each
     repository that gave context to the issue.
2. Compare each source owner with the target owner. Ignore case. Do not use an API call to
   find if two owners are in one enterprise.
3. For each source with a different owner, remove its details from the title, the body and
   each proposed comment. These are repository names, issue and pull request numbers, file
   paths, URLs, branch names and measurements. Write the idea in general words, for example
   "a skill in a different repository".
4. Add one line to the proposal that gives the kinds of detail that you removed. Do not
   give the details. For example: `Omitted: repository names, issue numbers, file paths`.
   A subagent adds the same line to the proposal that it returns.
