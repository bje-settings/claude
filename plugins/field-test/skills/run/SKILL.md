---
name: run
description: >
  Run a skill or command as a field test: observe it under this plugin's hooks, collect what
  actually happened from the recorded events, and file one reproducible issue per problem on the
  repository that owns the plugin under test. The target is not told it is being watched, so its
  behaviour is its real behaviour, and nothing is fixed mid-run. Names from a repository outside
  the plugin's enterprise are redacted before anything is published. Every issue is shown before
  it is created.
allowed-tools: Bash, Read, Skill, SlashCommand, AskUserQuestion
disable-model-invocation: true
---

Run `<target> [args...]` as a field test. You observe. You do not fix the target, you do not
improve on what it did, and you never tell it that it is being tested: a target that knows it is
under observation is not the thing you set out to measure.

`S="bash ${CLAUDE_PLUGIN_ROOT}/scripts"` below.

## Step 1: Resolve the target

```bash
RUN="$($S/ft-run.sh dir)"; mkdir -p "$RUN"
$S/ft-resolve.sh <target> > "$RUN/resolved.json"
```

Everything this run writes goes under `$RUN`, the run directory this session owns. A fixed path
in `/tmp` would let two runs hand each other the wrong redaction table, which is the one file
that decides whether a name outside the enterprise reaches a public issue.

- exit 3 or 5: stop and print the script's stderr line as it stands. An unresolved target is not
  a target to guess at, and a Workflow target is refused because the hooks may never see it.
- exit 0: read the JSON. `repo` is the repository that owns the plugin, and it is where issues
  go. If it is `null`, say so and ask the user which repository to file against before going on.

## Step 2: Start the run

```bash
$S/ft-run.sh start <target> --resolved "$RUN/resolved.json" --cwd <the directory to run in> -- <args...>
```

Exit 3 means a field test is already running in this session; finish or abandon that one first.

From here the hooks are recording every Bash call, every subagent that stops, every turn
boundary, and any command the deny list refuses. Nothing else needs to be done to watch.

## Step 3: Invoke the target

Invoke it with the arguments passed through **unaltered**. Do not add a flag it was not given, do
not remove one, and do not prefix the invocation with an explanation of what you are doing.

Which tool depends on `kind` from step 1: a `plugin-skill` or `skill` target goes through the
`Skill` tool, a `command` target through `SlashCommand`. A command is not a skill, and the wrong
tool does not run it.

While it runs: read what it reports, and do not intervene. If it asks you a question, answer as
the user would want, briefly, without mentioning the field test. If it takes a destructive action
the deny list blocks, it will see the refusal and carry on; that is a finding, not your problem
to solve.

## Step 4: Collect

```bash
$S/ft-run.sh finish
$S/ft-collect.sh "$RUN"
$S/ft-enterprise.sh <plugin marketplace_path from step 1> <the directory the target ran in>
$S/ft-issue.sh names <the directory the target ran in> --run "$RUN" > "$RUN/names.json"
```

A non-zero exit from `ft-run.sh finish` means the run marker is gone or corrupt: print its
stderr line and stop there, do not collect.

`ft-collect.sh "$RUN" --report` prints the target's own final message when you need to check
what it claimed against what it did.

## Step 5: Decide what is real

Each collected record is a *candidate*. Read each one against what the target was trying to do
and decide: a real problem, or the target working correctly?

- A command that exits non-zero **and is handled** is not a bug. A `git merge-base --is-ancestor`
  that exits 1 is a question being answered; a `grep` with no match is a query with no rows.
- A step the target reports as skipped, with a reason, having exited 0, is the target working.
- A `denied` record is always a real finding, and the highest priority one: the target reached
  for something a field test had to stop.
- A `deny_list_error` record is always real, and it is about this plugin rather than the target:
  a rule was dropped, so nothing it names was refused all run. File it against the plugin's own
  repository and say which rule was lost.
- A `hook_error` record is always real, and it is also about this plugin: a hook raised, so that
  one tool call went through unrecorded and, if it was a `PreToolUse`, unfiltered. File it against
  the plugin's own repository with the traceback.
- A `subagent_contradiction` is a real finding unless the failure it names is one of the handled
  cases above.
- An `args_dropped` record is real only if the option should have reached that command. Options a
  skill consumes itself are expected.

Say out loud, in one line each, which candidates you dismissed and why. A dismissal that is not
stated is a bug that was never filed.

## Step 6: File

For each real finding, in severity order:

```bash
$S/ft-issue.sh render <record.json> "$RUN/run.json" "$RUN/names.json" [--inside]
```

Pass `--inside` only when `ft-enterprise.sh` said `inside: true`. Its answer decides this; do not
override it, and if it could not tell, the answer is no.

Then, before creating anything:

1. `$S/ft-issue.sh search <plugin repo> "<signature>"`. A number means the finding is already
   open: comment on that issue with what this run added, rather than opening a duplicate.
2. Show the user the rendered title and body in full, and ask whether to file it. Filing is
   publishing; it happens on a yes, per issue.
3. On a yes: `$S/ft-issue.sh ensure-label <plugin repo>` once, then create the issue with
   `gh issue create --repo <plugin repo> --title "<first line>" --body "<the rest>"
   --label bug --label field-test`.

## Step 7: Summarise

One table: finding, kind, severity, what you decided, issue number or "not filed" with the
reason. Below it, one line each for the redaction status (inside or outside, and why), the
commands the deny list blocked, and the target's own claim if it disagreed with what was
recorded.
