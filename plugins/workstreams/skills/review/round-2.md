# What round 2 adds

Append this to `round-brief.md` for round 2. Nothing in it replaces a step there.

---

## First job: round 1's own commits

Before you review the pull request, review round 1. List its commits
(`git -C <worktree> log --oneline <base>..<head>`). Check each change it made, for
WRONG and for INCOMPLETE. Reproduce each claim rather than read it.

This is the most valuable line in the brief. On nine of the ten pull requests reviewed
by hand in rounds 5 to 7, round 2 found round 1 wrong or incomplete:

- a guard that threw on a dangling symlink, found by three reviewers independently;
- a closed-stdout guard that swallowed every stream error rather than only the one, and
  a `--help` that hung forever because stdin was read before argv;
- a sandbox fix that pinned two git variables, but left four more and the credentials
  exposed, found by reproducing each override one at a time;
- a corrected claim that over-corrected into the opposite wrong claim;
- a false count fixed, with a second one of the same kind beside it untouched;
- seven of nine guard fixes with no test at all, because a test that names a guard is a
  claim and not a proof.

Round 1's findings and its rejected list, from its return:

`<round 1's findings and rejected list, from the return the caller passes, or "no round 1
return reached the caller">`

Do not raise anything on the rejected list again without NEW evidence. Hand every
reviewer that list by name.

## Then the pull request, once more

Everything `round-brief.md` says applies, with round 1's changes now part of the diff
you review.

## The rot check belongs here

Round 1 does not do it, because a substantial round 1 makes its own rot list stale.
Return the rot list against the FINAL diff, your own commits included.

## There is no round 3

`substantial` in your return is informational. Two rounds is the ceiling.
