# The plan shape this repository uses

One section per primitive:

1. What is left of the question phase.
2. The stream, with its layers, file sets, and size, and the one layer that changes each
   version line. Each layer fits one agent's budget. Split a layer that does not fit into
   more layers in the plan, never into slices by hand. The stream has one worktree, until
   #263.
3. The review loop per layer, with its review model and reviewers. A plan with no review
   model for a layer is not ready for approval. State no count of review rounds. The
   review state machine sets the count: round 2 runs only when the substantial rule in
   `skills/review/SKILL.md` (Markers) says so. The done condition is `done` by that state
   machine.
4. An estimate, with two figures for the reviews: the cost of one review round for each
   layer, and of two.
5. Verification.

`skills/stream/brief.md` is the template the plan feeds. So the skill's plan, once the
human approves it, answers what that template needs.
