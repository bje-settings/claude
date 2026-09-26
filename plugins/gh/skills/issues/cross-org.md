# An issue in the repository of a different owner

Do these steps before you report a comment for a duplicate: [create.md](create.md) step 1
or [batch.md](batch.md) step 1. Do them again before each write.

1. Find the owners:
   - Target: the owner of the repository that gets the issue or the comment.
   - Sources: the owner of each repository that gave context to the issue. If the working
     directory is in a repository, its owner is also a source.
2. Compare the owner names only. Ignore case. Orgs in one enterprise are different owners.
3. For each source with a different owner, remove its details from the title, the body and
   each comment. These are repository names, issue and pull request numbers, file
   paths, URLs and branch names. Measurements are details too, such as a token count or a
   run time. Write the idea in general words, for example "a skill in a different
   repository".
4. Add one line to the report that gives the kinds of detail that you removed. Do not
   give the details. For example: `Omitted: repository names, issue numbers, file paths`.
   In a table, add one such line under the table for each issue that lost details, with
   its title.
