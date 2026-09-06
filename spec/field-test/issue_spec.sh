# shellcheck shell=bash
Describe 'ft-issue.sh'
  BeforeEach 'setup_ft_sandbox'
  AfterEach 'cleanup_ft_sandbox'

  target() { ft_fixture_repo "$FT_SANDBOX/target" "${1:-acme-org/widgets}" "${2:-ssh}" >/dev/null; }
  names_file() { "$FT_ISSUE" names "$FT_SANDBOX/target" > "$FT_SANDBOX/names.json"; }

  record() {
    cat > "$FT_SANDBOX/record.json" <<JSON
{"kind": "${1:-bash_nonzero}", "severity": "${2:-medium}", "count": ${3:-1},
 "signature": "${1:-bash_nonzero}:gh pr merge --auto --squash N",
 "agent_id": "agent-1", "agent_type": "shepherd-repo",
 "evidence": {"command": "gh pr merge --auto --squash 11", "reason": null,
              "exit_code": 1, "stderr": "GraphQL: Pull request is in unstable status",
              "claim": "All four pull requests were merged.",
              "preceding": ["git fetch origin"]}}
JSON
  }

  Describe 'usage'
    It 'prints usage for --help'
      When run script "$FT_ISSUE" --help
      The status should be success
      The output should include 'ft-issue.sh names'
    End

    It 'exits 2 with usage when given nothing'
      When run script "$FT_ISSUE"
      The status should equal 2
      The stderr should include 'ft-issue.sh names'
    End

    It 'rejects an unknown command'
      When run script "$FT_ISSUE" file
      The status should equal 2
      The stderr should include 'unknown command: file'
    End
  End

  Describe 'names'
    It 'needs an existing directory'
      When run script "$FT_ISSUE" names "$FT_SANDBOX/nope"
      The status should equal 2
      The stderr should include 'existing repository directory'
    End

    It 'rejects an unknown argument'
      target
      When run script "$FT_ISSUE" names "$FT_SANDBOX/target" --deep
      The status should equal 2
      The stderr should include 'unknown argument'
    End

    It 'rejects --run with no value'
      target
      When run script "$FT_ISSUE" names "$FT_SANDBOX/target" --run
      The status should equal 2
      The stderr should include '--run needs a value'
    End

    It 'collects the remote, the slug, the owner, and the name'
      target
      When run script "$FT_ISSUE" names "$FT_SANDBOX/target"
      The status should be success
      The output should include '"repo": "acme-org/widgets"'
      The output should include '"placeholder": "<org>/<repo>"'
      The output should include '"placeholder": "<remote-url>"'
      The output should include '"placeholder": "<org>"'
      The output should include '"placeholder": "<repo>"'
    End

    It 'collects the branches and the recent commit subjects'
      target
      When run script "$FT_ISSUE" names "$FT_SANDBOX/target"
      The status should be success
      The output should include 'wktr-9-widget-fix'
      The output should include 'the widget drops its last field'
    End

    It 'orders the table longest value first, so owner/name beats owner'
      target
      longest() { "$FT_ISSUE" names "$FT_SANDBOX/target" | jq -r '[.placeholders[].value | length] | . == (sort | reverse)'; }
      When call longest
      The status should be success
      The output should equal 'true'
    End

    It 'collects the references seen during the run'
      target
      printf '%s\n' '{"event":"PostToolUse","command":"gh pr view 12 # closes #12","exit_code":0}' > "$FT_RUN_DIR/events.jsonl"
      When run script "$FT_ISSUE" names "$FT_SANDBOX/target" --run "$FT_RUN_DIR"
      The status should be success
      The output should include '"value": "#12"'
      The output should include '"placeholder": "<pr>"'
    End

    It 'still answers for a checkout with no remote, using the directory name'
      target acme-org/widgets none
      When run script "$FT_ISSUE" names "$FT_SANDBOX/target"
      The status should be success
      The output should include '"repo": null'
      The output should include '"value": "target"'
    End

    It 'drops a value too short to replace safely'
      ft_fixture_repo "$FT_SANDBOX/target" "a/b" >/dev/null
      When run script "$FT_ISSUE" names "$FT_SANDBOX/target"
      The status should be success
      The output should not include '"value": "a"'
      The output should not include '"value": "b"'
    End
  End

  Describe 'search'
    It 'needs a repo and a signature'
      When run script "$FT_ISSUE" search acme-org/plugins
      The status should equal 2
      The stderr should include 'search needs'
    End

    It 'finds the open field-test issue carrying the same signature'
      When run script "$FT_ISSUE" search acme-org/plugins 'bash_nonzero:gh pr merge --auto --squash N'
      The status should be success
      The output should equal '40'
    End

    It 'prints nothing when no open issue carries it'
      When run script "$FT_ISSUE" search acme-org/plugins 'denied:git push --force origin main'
      The status should be success
      The output should equal ''
    End

    It 'ignores an issue that is not labelled field-test'
      When run script "$FT_ISSUE" search acme-org/plugins 'is not a field-test issue'
      The status should be success
      The output should equal ''
    End

    It 'treats a gh failure as no match rather than a duplicate'
      export FT_GH_FIXTURE_FAIL=1
      When run script "$FT_ISSUE" search acme-org/plugins 'bash_nonzero:gh pr merge --auto --squash N'
      The status should be success
      The output should equal ''
    End
  End

  Describe 'ensure-label'
    It 'needs a repo'
      When run script "$FT_ISSUE" ensure-label
      The status should equal 2
      The stderr should include 'ensure-label needs'
    End

    It 'creates the label, and does not mind that it is already there'
      When run script "$FT_ISSUE" ensure-label acme-org/plugins
      The status should be success
      The output should include 'field-test'
    End

    It 'reports a failure rather than carrying on'
      export FT_GH_FIXTURE_FAIL=1
      When run script "$FT_ISSUE" ensure-label acme-org/plugins
      The status should equal 1
      The stderr should include 'could not create the field-test label'
    End
  End

  Describe 'render'
    It 'needs all three files'
      When run script "$FT_ISSUE" render "$FT_SANDBOX/nope.json"
      The status should equal 2
      The stderr should include 'render needs'
    End

    It 'rejects an unknown argument'
      target; names_file; record
      When run script "$FT_ISSUE" render "$FT_SANDBOX/record.json" "$FT_RUN_DIR/run.json" "$FT_SANDBOX/names.json" --outside
      The status should equal 2
      The stderr should include 'unknown argument'
    End

    It 'puts the title on the first line, in the repository commit convention'
      target; names_file; record
      When run script "$FT_ISSUE" render "$FT_SANDBOX/record.json" "$FT_RUN_DIR/run.json" "$FT_SANDBOX/names.json" --inside
      The status should be success
      The line 1 of output should equal 'fix: gh:shepherd: gh pr merge --auto --squash N'
    End

    It 'uses test rather than fix when the finding is a missing check'
      target; names_file; record args_dropped low
      When run script "$FT_ISSUE" render "$FT_SANDBOX/record.json" "$FT_RUN_DIR/run.json" "$FT_SANDBOX/names.json" --inside
      The status should be success
      The line 1 of output should include 'test: gh:shepherd:'
    End

    It 'writes the expected and actual for the kind of finding'
      target; names_file; record denied high
      When run script "$FT_ISSUE" render "$FT_SANDBOX/record.json" "$FT_RUN_DIR/run.json" "$FT_SANDBOX/names.json" --inside
      The status should be success
      The output should include 'reach for a command that cannot be undone'
      The output should include 'the field-test hook blocked it'
    End

    It 'quotes the claim back when a subagent contradicted itself'
      target; names_file; record subagent_contradiction high
      When run script "$FT_ISSUE" render "$FT_SANDBOX/record.json" "$FT_RUN_DIR/run.json" "$FT_SANDBOX/names.json" --inside
      The status should be success
      The output should include 'All four pull requests were merged.'
      The output should include 'never resolved'
    End

    It 'describes what a tool_failure fixture would have to reproduce'
      target; names_file; record tool_failure
      When run script "$FT_ISSUE" render "$FT_SANDBOX/record.json" "$FT_RUN_DIR/run.json" "$FT_SANDBOX/names.json" --inside
      The status should be success
      The output should include 'built by the fixtures rather than mocked'
    End

    It 'carries the run detail an issue is useless without'
      target; names_file; record
      When run script "$FT_ISSUE" render "$FT_SANDBOX/record.json" "$FT_RUN_DIR/run.json" "$FT_SANDBOX/names.json" --inside
      The status should be success
      The output should include '`gh` 0.2.0'
      The output should include '0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6'
      The output should include '2.1.263 (Claude Code)'
      The output should include '--dry-run'
      The output should include 'git fetch origin'
    End

    It 'redacts the repository under test when the run was outside the enterprise'
      target; names_file; record
      When run script "$FT_ISSUE" render "$FT_SANDBOX/record.json" "$FT_RUN_DIR/run.json" "$FT_SANDBOX/names.json"
      The status should be success
      The output should include 'outside the plugin'
      The output should not include 'acme-org/widgets'
    End
  End
  It 'requires jq'
    export PATH="$(ft_path_without jq)"
    When run script "$FT_ISSUE" search acme-org/plugins sig
    The status should equal 1
    The stderr should include 'jq is required'
  End

End
