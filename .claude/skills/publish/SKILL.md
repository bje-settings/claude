---
name: publish
description: >
  Publish one plugin from this marketplace into a downstream repository as a
  read-only copy, for a team that cannot read this repo. Runs the suite and
  manifest validation first, mirrors what is committed, and opens a pull request
  in the destination. Never commits here, never merges there.
argument-hint: <plugin-name> <path-to-destination-repo>
allowed-tools: Bash
disable-model-invocation: true
---

Publish `$ARGUMENTS` as a read-only copy.

This exists because this repo is internal to the `bje` enterprise: a team that cannot read it
cannot install from it either. Until the repo is published, one plugin at a time is mirrored into
a repository that team can read, and that repository carries its own marketplace manifest.

The script does the deterministic half and refuses on its own; the judgment here is everything
around it. Do not re-implement its checks or second-guess a refusal.

## Step 1 — Read the arguments

Two are required: the plugin directory name under `plugins/`, and a path to the destination
checkout. If either is missing, ask. Never guess a destination path, and never assume the
destination exists to host this plugin: it may have plugins of its own.

## Step 2 — Preflight this repo

```bash
git status --porcelain
git rev-parse --abbrev-ref HEAD
git fetch --quiet origin && git status -sb | head -1
```

Stop and say why if the tree is dirty, HEAD is not the default branch, or the branch is behind.
A publish copies what is committed, so publishing from a stale or dirty checkout ships something
nobody reviewed.

## Step 3 — Prove the plugin is good before copying it

```bash
uv run --locked pytest -n auto --cov --cov-report=xml
python3 tests/coverage_check.py coverage/python.xml 95
claude plugin validate . --strict
```

The tests do not travel with the copy, so this is the only place they run for it. A failure here
stops the publish.

## Step 4 — See what would change, and decide about the version

```bash
python3 scripts/publish-plugin.py <plugin> <dest> --check
```

Exit 0 means the copy is already current and there is nothing to do; say so and stop. Exit 1 means
there is drift, and the report names every file. Exit 2 is a refusal: read it, fix the cause, do
not work around it.

The report prints the version the copy records. If content changed but the plugin's `version` in
`plugins/<plugin>/.claude-plugin/plugin.json` did not, raise that now: downstream, the version is
how anyone tells one copy from another. Bumping it is a commit in this repo, so it happens before
the publish, not after.

## Step 5 — Publish

```bash
python3 scripts/publish-plugin.py <plugin> <dest>
```

Nothing is committed downstream. Show the report.

## Step 6 — Open a pull request in the destination

Work in the destination checkout, never here. Branch, commit, push, open a PR. Keep the body
short: what changed, the upstream version and commit the copy now records, and that the directory
is a generated read-only mirror rather than something to edit in place.

Do not merge it. Do not enable auto-merge. The destination repo's reviewers decide.

## What this never does

Commit in this repo, merge downstream, edit the copy after writing it, or touch anything in the
destination outside `plugins/<plugin>/`.
