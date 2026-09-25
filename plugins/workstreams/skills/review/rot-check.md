# The rot check

The caller's job, once, after the last round. It is not small. A pull request that has
been through two review rounds has needed five to ten corrections, every time anyone
measured it. The round agents' consolidated rot lists make it a fifteen-minute job
instead of an hour.

Do the check even when every round returned "rot list: empty". Two rounds returned that
on pull requests whose bodies had ten stale claims, because a round does not count the
claims its own commits made false.

## What to check

Read the final diff (`gh pr diff <n>`) and the pull request as it stands
(`gh pr view <n> --json title,body`). Then check:

1. **The title.** It becomes the squash commit message, so it is a Conventional Commit
   that describes what the diff does now, not what the first push did.
2. **Every number.** Test counts, line counts, coverage figures, how many files. Each
   one is re-derived, never carried over.
3. **Every table that names a test.** A row that claims a test pins a behaviour is a
   claim. If a round's mutation showed it does not, the row is false.
4. **Every sentence a fix made untrue.** A reason given for a decision the round
   reversed, a "kept for X" whose X is gone, a described behaviour that changed.
5. **The claims the rounds listed.** Each entry of each `rot_list`, applied or dismissed
   with a reason.
6. **Anything the body says was verified.** If a round's own findings contradict it, the
   verification is the thing to correct.

## Then

Rewrite the title and body with `gh pr edit <n> --title ... --body-file ...`. The round
agents never do this: if two of them edited one body, they would fight over it.

Say in the report which claims were corrected and which were re-derived and held.
