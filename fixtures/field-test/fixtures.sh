#!/usr/bin/env bash
# fixtures.sh: canned input for the field-test specs.
#
# Source this. Each function writes one fixture. The shapes are reconstructed from
# field tests of /gh:shepherd and /workstreams:run, not copied from them: no repo
# name, PR number, or commit subject here came from a repository outside the bje
# enterprise, per CLAUDE.md.
#
# What is left here is what the harden-side specs still need: the plugin registry
# the preflight reads, and the pull requests and reports the wait and verify
# scripts are pointed at. The run side of the plugin is Python and its fixtures
# are tests/field-test/conftest.py; issue #60 moves the rest of this file across
# with the scripts that still read it.
#
# Written for bash 3.2, like the scripts under test.

# ft_fixture_installed_plugins <path> <install-dir>
# The shape of ~/.claude/plugins/installed_plugins.json, version 2, as the harden
# preflight reads it: one plugin the preflight requires and one it does not.
ft_fixture_installed_plugins() {
  local path="$1" install="$2"
  cat > "$path" <<JSON
{"version": 2, "plugins": {
  "gh@bje": [{"scope": "user", "installPath": "$install", "version": "0.2.0"}],
  "pr-review-toolkit@official": [{"scope": "user", "installPath": "$install-other", "version": "abc123"}]}}
JSON
}

# ft_fixture_prs <path>: the pull requests fixtures/field-test/bin/gh serves to
# `gh pr view`, covering every arm of scripts/lib/checks.jq and every claim
# ft-verify-report.sh can be handed.
#
#   50 open, every check green, skipped, or neutral      checks pass
#   51 open, a FAILURE beside a SUCCESS                 checks fail
#   52 open, a run still in progress and a PENDING      checks pending
#   53 open, no checks at all                           checks none
#   54 merged                                           state MERGED
#   55 closed unmerged                                  state CLOSED
#   56 open, a COMPLETED run with no conclusion         checks pending
#   57 open, CANCELLED beside SUCCESS                   checks fail
#   58 open, pending on the first look then green       a sequence; green stays
#   59 open, a commit status in FAILURE beside a green  checks fail (StatusContext)
#   60 open, a FAILURE beside a run still in progress   checks fail, not pending
#   61 open, no checks on the first look, then a run    a sequence; none then pending
ft_fixture_prs() {
  cat > "$1" <<'JSON'
[
  {"number": 50, "state": "OPEN", "isDraft": false,
   "statusCheckRollup": [
     {"__typename": "CheckRun", "name": "bash-5", "status": "COMPLETED", "conclusion": "SUCCESS"},
     {"__typename": "CheckRun", "name": "shellcheck", "status": "COMPLETED", "conclusion": "SKIPPED"},
     {"__typename": "CheckRun", "name": "codeql", "status": "COMPLETED", "conclusion": "NEUTRAL"},
     {"__typename": "StatusContext", "context": "coverage", "state": "SUCCESS"}]},
  {"number": 51, "state": "OPEN", "isDraft": false,
   "statusCheckRollup": [
     {"__typename": "CheckRun", "name": "bash-5", "status": "COMPLETED", "conclusion": "SUCCESS"},
     {"__typename": "CheckRun", "name": "coverage", "status": "COMPLETED", "conclusion": "FAILURE"}]},
  {"number": 52, "state": "OPEN", "isDraft": false,
   "statusCheckRollup": [
     {"__typename": "CheckRun", "name": "bash-3.2", "status": "IN_PROGRESS", "conclusion": null},
     {"__typename": "StatusContext", "context": "coverage", "state": "PENDING"}]},
  {"number": 53, "state": "OPEN", "isDraft": false, "statusCheckRollup": []},
  {"number": 54, "state": "MERGED", "isDraft": false,
   "statusCheckRollup": [{"__typename": "StatusContext", "context": "ci", "state": "SUCCESS"}]},
  {"number": 55, "state": "CLOSED", "isDraft": false, "statusCheckRollup": []},
  {"number": 56, "state": "OPEN", "isDraft": false,
   "statusCheckRollup": [{"__typename": "CheckRun", "name": "bash-5", "status": "COMPLETED", "conclusion": null}]},
  {"number": 57, "state": "OPEN", "isDraft": false,
   "statusCheckRollup": [
     {"__typename": "CheckRun", "name": "bash-5", "status": "COMPLETED", "conclusion": "SUCCESS"},
     {"__typename": "CheckRun", "name": "coverage", "status": "COMPLETED", "conclusion": "CANCELLED"}]},
  {"number": 58, "state": "OPEN", "isDraft": true,
   "statusCheckRollup": [{"__typename": "CheckRun", "name": "bash-5", "status": "COMPLETED", "conclusion": "SUCCESS"}],
   "sequence": [
     {"statusCheckRollup": [{"__typename": "CheckRun", "name": "bash-5", "status": "IN_PROGRESS", "conclusion": null}]},
     {"statusCheckRollup": [{"__typename": "CheckRun", "name": "bash-5", "status": "COMPLETED", "conclusion": "SUCCESS"}]}]},
  {"number": 59, "state": "OPEN", "isDraft": false,
   "statusCheckRollup": [
     {"__typename": "CheckRun", "name": "bash-5", "status": "COMPLETED", "conclusion": "SUCCESS"},
     {"__typename": "StatusContext", "context": "coverage", "state": "FAILURE"}]},
  {"number": 60, "state": "OPEN", "isDraft": false,
   "statusCheckRollup": [
     {"__typename": "CheckRun", "name": "coverage", "status": "COMPLETED", "conclusion": "FAILURE"},
     {"__typename": "CheckRun", "name": "bash-3.2", "status": "IN_PROGRESS", "conclusion": null}]},
  {"number": 61, "state": "OPEN", "isDraft": false,
   "statusCheckRollup": [{"__typename": "CheckRun", "name": "bash-5", "status": "IN_PROGRESS", "conclusion": null}],
   "sequence": [{"statusCheckRollup": []}]}
]
JSON
}

# ft_fixture_report <path> <case>: what a field-test report claimed about the
# pull requests of one round.
#
#   accurate   every claim holds against ft_fixture_prs
#   wrong      claims a pull request merged that is still open
#   unknown    uses a word the verifier cannot check
#   missing    names a pull request that does not exist
ft_fixture_report() {
  local path="$1" name="${2:-accurate}"
  case "$name" in
    accurate)
      cat > "$path" <<'JSON'
{"repo": "acme-org/plugins",
 "prs": [{"number": 54, "claimed": "merged"},
         {"number": 50, "claimed": "skipped"},
         {"number": 55, "claimed": "closed"}]}
JSON
      ;;
    wrong)
      cat > "$path" <<'JSON'
{"repo": "acme-org/plugins", "prs": [{"number": 50, "claimed": "merged"}]}
JSON
      ;;
    unknown)
      cat > "$path" <<'JSON'
{"repo": "acme-org/plugins", "prs": [{"number": 50, "claimed": "shepherded"}]}
JSON
      ;;
    missing)
      cat > "$path" <<'JSON'
{"repo": "acme-org/plugins", "prs": [{"number": 999, "claimed": "merged"}]}
JSON
      ;;
    *)
      printf 'ft_fixture_report: unknown case: %s\n' "$name" >&2
      return 1
      ;;
  esac
}
