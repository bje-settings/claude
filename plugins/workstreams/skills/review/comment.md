# Review comment

A comment on the pull request tells a person what a round did. `pr-state` does not read it.
Post it with `gh pr comment <number> --body-file -` and a quoted heredoc, so the shell keeps
the backticks. The date is today's.

## Round comment

```bash
gh pr comment <number> --body-file - <<'EOF_COMMENT'
Review round <1|2> done.

Head <sha>. Model: <model>. Reviewers: <list>. Applied <n>, rejected <n>. <Round 1 only: Substantial|Minor>.

<details>
<summary>Findings</summary>

**Applied**

- R<round>.1 <finding>. Source: <reviewer>. Verified: <file:line>.

**Rejected**

- R<round>.2 <finding>. Source: <reviewer>. Why: <reason>.

**Verified**

<what the round checked and found true>

</details>

<sub>_Recorded by `workstreams:review` <date>._</sub>
EOF_COMMENT
```

- Line 1 is exactly `Review round 1 done.` or `Review round 2 done.`.
- Number the findings `R<round>.<n>`: applied first, then rejected, one sequence for each
  round.
- Take each source, `verified` and `why` from the round agent's return. Take the model and
  the reviewers from the dispatch, and the Verified block from the return's prose.
- Name the classification in the summary for round 1 only. Round 2 has no classification.

## Rot check comment

Line 1 is `Rot check done.`. Then say which claims you corrected and which held. With more than
three items, put them in a `<details>` block with `<summary>Claims</summary>`, as above. End
with the same `<sub>` footer.
