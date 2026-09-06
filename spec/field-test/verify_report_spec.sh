# shellcheck shell=bash
# One example per arm of scripts/lib/verify.jq. A report is a claim, and the arms
# that matter are the ones where the claim is wrong or unverifiable: those are the
# cases the by-hand hardening loop had to catch by reading every pull request.
Describe 'ft-verify-report.sh'
  BeforeEach 'setup_ft_sandbox'
  AfterEach 'cleanup_ft_sandbox'

  report() { ft_fixture_report "$FT_SANDBOX/report.json" "${1:-accurate}"; }

  Describe 'usage'
    It 'prints usage for --help'
      When run script "$FT_VERIFY_REPORT" --help
      The status should be success
      The output should include 'ft-verify-report.sh <report.json>'
    End

    It 'exits 2 with usage when given nothing'
      When run script "$FT_VERIFY_REPORT"
      The status should equal 2
      The stderr should include 'ft-verify-report.sh <report.json>'
    End

    It 'refuses a report that is not there'
      When run script "$FT_VERIFY_REPORT" "$FT_SANDBOX/nope.json"
      The status should equal 2
      The stderr should include 'no report at'
    End

    It 'refuses a report with no pull requests in it'
      printf '{"repo": "acme-org/plugins"}' > "$FT_SANDBOX/report.json"
      When run script "$FT_VERIFY_REPORT" "$FT_SANDBOX/report.json"
      The status should equal 2
      The stderr should include 'no prs array'
    End

    It 'refuses to guess the repository'
      printf '{"prs": []}' > "$FT_SANDBOX/report.json"
      When run script "$FT_VERIFY_REPORT" "$FT_SANDBOX/report.json"
      The status should equal 2
      The stderr should include 'no repository'
    End

    It 'rejects an unknown argument'
      report
      When run script "$FT_VERIFY_REPORT" "$FT_SANDBOX/report.json" --strict
      The status should equal 2
      The stderr should include 'unknown argument'
    End

    It 'rejects --repo with no value'
      report
      When run script "$FT_VERIFY_REPORT" "$FT_SANDBOX/report.json" --repo
      The status should equal 2
      The stderr should include '--repo needs a value'
    End

    It 'requires jq'
      report
      export PATH="$(ft_path_without jq)"
      When run script "$FT_VERIFY_REPORT" "$FT_SANDBOX/report.json"
      The status should equal 1
      The stderr should include 'jq is required'
    End
  End

  Describe 'comparing claims against GitHub'
    It 'passes a report where merged, skipped, and closed all hold'
      report accurate
      When run script "$FT_VERIFY_REPORT" "$FT_SANDBOX/report.json"
      The status should be success
      The output should include '"ok": true'
      The output should include '"checked": 3'
      The output should include '"matched": 3'
      The output should include '"mismatches": []'
    End

    It 'catches a pull request the report claimed merged that is still open'
      report wrong
      When run script "$FT_VERIFY_REPORT" "$FT_SANDBOX/report.json"
      The status should equal 1
      The output should include '"ok": false'
      The output should include 'the report said merged; GitHub says open'
    End

    It 'refuses to pass a claim in a word it cannot check'
      report unknown
      When run script "$FT_VERIFY_REPORT" "$FT_SANDBOX/report.json"
      The status should equal 1
      The output should include 'used a word this cannot check: shepherded'
    End

    It 'treats a pull request gh cannot answer for as a mismatch, not a pass'
      report missing
      When run script "$FT_VERIFY_REPORT" "$FT_SANDBOX/report.json"
      The status should equal 1
      The output should include 'could not be read on GitHub'
      The output should include 'Could not resolve to a PullRequest'
    End

    It 'reads the repository from --repo over the one in the report'
      report accurate
      jq '.repo = "nope/nope"' "$FT_SANDBOX/report.json" > "$FT_SANDBOX/x"
      mv "$FT_SANDBOX/x" "$FT_SANDBOX/report.json"
      When run script "$FT_VERIFY_REPORT" "$FT_SANDBOX/report.json" --repo acme-org/plugins
      The status should be success
      The output should include '"ok": true'
    End

    It 'catches a closed pull request the report called merged'
      printf '{"repo": "acme-org/plugins", "prs": [{"number": 55, "claimed": "merged"}]}' > "$FT_SANDBOX/report.json"
      When run script "$FT_VERIFY_REPORT" "$FT_SANDBOX/report.json"
      The status should equal 1
      The output should include '"actual": "closed"'
    End

    It 'accepts open as well as skipped for a pull request left alone'
      printf '{"repo": "acme-org/plugins", "prs": [{"number": 50, "claimed": "open"}]}' > "$FT_SANDBOX/report.json"
      When run script "$FT_VERIFY_REPORT" "$FT_SANDBOX/report.json"
      The status should be success
      The output should include '"ok": true'
    End

    It 'catches a skip claimed for a pull request that actually merged'
      printf '{"repo": "acme-org/plugins", "prs": [{"number": 54, "claimed": "skipped"}]}' > "$FT_SANDBOX/report.json"
      When run script "$FT_VERIFY_REPORT" "$FT_SANDBOX/report.json"
      The status should equal 1
      The output should include 'the report said skipped; GitHub says merged'
    End

    It 'treats a report with no claims as nothing to disprove'
      printf '{"repo": "acme-org/plugins", "prs": []}' > "$FT_SANDBOX/report.json"
      When run script "$FT_VERIFY_REPORT" "$FT_SANDBOX/report.json"
      The status should be success
      The output should include '"checked": 0'
    End

    It 'reports every claim, not only the ones that failed'
      report accurate
      When run script "$FT_VERIFY_REPORT" "$FT_SANDBOX/report.json"
      The status should be success
      The output should include '"results"'
      The value "$("$FT_VERIFY_REPORT" "$FT_SANDBOX/report.json" | jq '.results | length')" should equal '3'
    End
  End
End
