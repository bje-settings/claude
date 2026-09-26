# An issue in the repository of a different owner

Do these steps before the confirm step: [create.md](create.md) step 7,
[batch.md](batch.md) step 4 or [triage.md](triage.md) step 5. When the request sets every
value, do them before the write.

1. Find the owners:
   - Target: the owner of the repository that gets the issue.
   - Sources: the owner of the working directory's repository, and the owner of each
     repository that gave context to the issue.
2. Find the scope of each source:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/gh.ts" org-scope --target <target owner> <source owner> <source owner>
   ```

3. Read the `scope` of each source in `results`:
   - `same-owner` or `same-enterprise`: the issue can name the details of that source.
   - `outside` or `unknown`: do step 4 for that source.

   If the command does not exit 0, do step 4 for each source.

4. Remove the details of the source from the title, the body and each proposed comment.
   These are repository names, issue and pull request numbers, file paths, URLs, branch
   names and measurements. Write the idea in general words, for example "a skill in a
   different repository".
5. Add one line to the proposal that gives the kinds of detail that you removed, not the
   details: `Omitted: repository names, issue numbers, file paths`. A subagent adds the
   same line to the proposal that it returns.
