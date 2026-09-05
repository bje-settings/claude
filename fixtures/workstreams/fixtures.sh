#!/usr/bin/env bash
# fixtures.sh — canned GitHub data for the workstreams specs.
#
# Source this. Each function writes one fixture file that fixtures/workstreams/bin/gh
# serves. The shapes are reconstructed from the field test in issue #7 (a debugging
# session that produced two bugs, a chore, a refactor, and a spike) without copying
# anything from that repository.
#
# Written for bash 3.2, like the scripts under test.

# ws_fixture_issues <path> — six issues:
#   1 bug     open   refs #2 and #4 in its body            (work now, touches src/parser)
#   2 chore   open   no body                              (mechanical)
#   3 refactor open  refs #1                              (collides with #1)
#   4 spike   open   milestone "observe"                  (defer)
#   5 bug     closed refs nothing                         (already done)
#   6 docs    open   label "docs", body mentions "url/#7" which is not a reference
ws_fixture_issues() {
  cat > "$1" <<'JSON'
[
  {"number": 1, "title": "fix: parser drops trailing field", "state": "OPEN", "url": "https://example.invalid/i/1",
   "labels": [{"name": "bug"}], "milestone": null,
   "body": "Seen in the logs from #2. Touches src/parser.sh. Might be the same root cause as #4."},
  {"number": 2, "title": "chore: pin the linter", "state": "OPEN", "url": "https://example.invalid/i/2",
   "labels": [{"name": "chore"}], "milestone": null, "body": null},
  {"number": 3, "title": "refactor: split parser into read and emit", "state": "OPEN", "url": "https://example.invalid/i/3",
   "labels": [{"name": "refactor"}], "milestone": null,
   "body": "Depends on the fix in #1 landing first so the split does not move the bug."},
  {"number": 4, "title": "spike: measure parser throughput on device", "state": "OPEN", "url": "https://example.invalid/i/4",
   "labels": [{"name": "spike"}], "milestone": {"title": "observe"},
   "body": "Needs the hardware. Collect a week of data before deciding."},
  {"number": 5, "title": "fix: typo in usage text", "state": "CLOSED", "url": "https://example.invalid/i/5",
   "labels": [{"name": "bug"}], "milestone": null, "body": "Fixed already."},
  {"number": 6, "title": "docs: describe the parser", "state": "OPEN", "url": "https://example.invalid/i/6",
   "labels": [{"name": "docs"}], "milestone": null,
   "body": "See https://example.invalid/wiki/#7 for the old page; that anchor is not an issue."}
]
JSON
}

# ws_fixture_prs <path> — pull requests covering every checks outcome:
#   10 draft, checks pass (two CheckRuns, one SKIPPED)
#   11 draft, checks fail (one FAILURE among successes)
#   12 draft, checks pending (a CheckRun still IN_PROGRESS, a StatusContext PENDING)
#   13 ready, no checks, review APPROVED, mergeable null
#   14 merged, StatusContext SUCCESS only
ws_fixture_prs() {
  cat > "$1" <<'JSON'
[
  {"number": 10, "url": "https://example.invalid/p/10", "title": "fix: parser drops trailing field", "state": "OPEN",
   "isDraft": true, "baseRefName": "main", "headRefName": "wktr-1-parser-fix", "headRefOid": "aaa111",
   "mergeable": "MERGEABLE", "reviewDecision": null,
   "statusCheckRollup": [
     {"__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "SUCCESS"},
     {"__typename": "CheckRun", "name": "lint", "status": "COMPLETED", "conclusion": "SKIPPED"}]},
  {"number": 11, "url": "https://example.invalid/p/11", "title": "chore: pin the linter", "state": "OPEN",
   "isDraft": true, "baseRefName": "main", "headRefName": "wktr-2-pin-linter", "headRefOid": "bbb222",
   "mergeable": "CONFLICTING", "reviewDecision": "CHANGES_REQUESTED",
   "statusCheckRollup": [
     {"__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "SUCCESS"},
     {"__typename": "CheckRun", "name": "lint", "status": "COMPLETED", "conclusion": "FAILURE"}]},
  {"number": 12, "url": "https://example.invalid/p/12", "title": "refactor: split parser", "state": "OPEN",
   "isDraft": true, "baseRefName": "wktr-1-parser-fix", "headRefName": "wktr-3-split-parser", "headRefOid": "ccc333",
   "mergeable": "UNKNOWN", "reviewDecision": null,
   "statusCheckRollup": [
     {"__typename": "CheckRun", "name": "test", "status": "IN_PROGRESS", "conclusion": null},
     {"__typename": "StatusContext", "context": "coverage", "state": "PENDING"}]},
  {"number": 13, "url": "https://example.invalid/p/13", "title": "docs: describe the parser", "state": "OPEN",
   "isDraft": false, "baseRefName": "main", "headRefName": "wktr-6-parser-docs", "headRefOid": "ddd444",
   "mergeable": null, "reviewDecision": "APPROVED", "statusCheckRollup": []},
  {"number": 14, "url": "https://example.invalid/p/14", "title": "fix: typo in usage text", "state": "MERGED",
   "isDraft": false, "baseRefName": "main", "headRefName": "wktr-5-typo", "headRefOid": "eee555",
   "mergeable": "UNKNOWN", "reviewDecision": "APPROVED",
   "statusCheckRollup": [{"__typename": "StatusContext", "context": "ci", "state": "SUCCESS"}]}
]
JSON
}

# ws_fixture_extensions <path> [with-stack|without-stack]
ws_fixture_extensions() {
  if [[ "${2:-with-stack}" == "with-stack" ]]; then
    printf 'gh stack\tgithub/gh-stack\tv0.1.0\ngh dash\tdlvhdr/gh-dash\tv4.0.0\n' > "$1"
  else
    printf 'gh dash\tdlvhdr/gh-dash\tv4.0.0\n' > "$1"
  fi
}

# ws_fixture_installed_plugins <path> [with-review|without-review]
# Mirrors the shape of ~/.claude/plugins/installed_plugins.json.
ws_fixture_installed_plugins() {
  if [[ "${2:-with-review}" == "with-review" ]]; then
    cat > "$1" <<'JSON'
{"version": 2, "plugins": {
  "pr-review-toolkit@claude-plugins-official": [{"scope": "user", "version": "abc123"}],
  "gh@bje": [{"scope": "user", "version": "def456"}]}}
JSON
  else
    cat > "$1" <<'JSON'
{"version": 2, "plugins": {"gh@bje": [{"scope": "user", "version": "def456"}]}}
JSON
  fi
}

# ws_fixture_home <dir> [with-skill|without-skill] — a fake $HOME with (or without)
# the gh-stack skill installed the way `gh skill install` lays it out.
ws_fixture_home() {
  mkdir -p "$1/.claude/skills" "$1/.claude/plugins"
  if [[ "${2:-with-skill}" == "with-skill" ]]; then
    mkdir -p "$1/.claude/skills/gh-stack"
    printf -- '---\nname: gh-stack\n---\n' > "$1/.claude/skills/gh-stack/SKILL.md"
  fi
}
