# shellcheck shell=bash
# Redaction can only fail in two ways, and both are checked here against a real
# repository rather than a hand-written table: a name that survives into a public
# issue, and a name that is stripped from an issue that was entitled to keep it.
Describe 'ft-redact.sh'
  BeforeEach 'setup_ft_sandbox'
  AfterEach 'cleanup_ft_sandbox'

  # A repository with a remote, a branch, commit subjects, and a #N in the run.
  build_names() {
    ft_fixture_repo "$FT_SANDBOX/target" "${1:-acme-org/widgets}" >/dev/null
    printf '%s\n' '{"event":"PostToolUse","command":"gh pr view 12 --json url # see #12","exit_code":0}' \
      > "$FT_RUN_DIR/events.jsonl"
    "$FT_ISSUE" names "$FT_SANDBOX/target" --run "$FT_RUN_DIR" > "$FT_SANDBOX/names.json"
  }

  # Every name in the table, one per line, ready to be looked for in the output.
  values() { jq -r '.placeholders[].value' "$FT_SANDBOX/names.json"; }

  # The text an issue body would be built from: every name, in the shapes they
  # appear in real evidence.
  sample() {
    cat <<TXT
Ran against acme-org/widgets, cloned from git@github.com:acme-org/widgets.git.
Checkout at $FT_SANDBOX/target, on branch wktr-9-widget-fix.
Commit under test: "fix: the widget drops its last field" (see #12).
Owner acme-org, repository widgets.
TXT
  }

  # Names that are still in the redacted output. Should be empty, always.
  survivors() {
    local value
    while IFS= read -r value; do
      [ -n "$value" ] || continue
      case "$(sample | "$FT_REDACT" "$FT_SANDBOX/names.json")" in
        *"$value"*) printf '%s\n' "$value" ;;
      esac
    done <<EOF
$(values)
EOF
  }

  It 'prints usage for --help'
    When run script "$FT_REDACT" --help
    The status should be success
    The output should include 'ft-redact.sh <names.json>'
  End

  It 'exits 2 with usage when given nothing'
    When run script "$FT_REDACT"
    The status should equal 2
    The stderr should include 'ft-redact.sh <names.json>'
  End

  It 'rejects an unknown argument'
    build_names
    When run script "$FT_REDACT" "$FT_SANDBOX/names.json" --outside
    The status should equal 2
    The stderr should include 'unknown argument'
  End

  It 'refuses a names file that is not there'
    When run script "$FT_REDACT" "$FT_SANDBOX/nope.json"
    The status should equal 2
    The stderr should include 'no names file'
  End

  It 'reports a names file that is not JSON'
    printf 'nope' > "$FT_SANDBOX/names.json"
    Data 'text'
    When run script "$FT_REDACT" "$FT_SANDBOX/names.json"
    The status should equal 1
    The stderr should include 'not valid JSON'
  End

  # Every file a run writes is a JSON object in the same directory, so the wrong one
  # parses. Redacting nothing and appending the note anyway is how a real repository
  # name reaches a public issue under a line saying it was removed.
  It 'refuses JSON that is not a names table, rather than redacting nothing and saying it did'
    printf '%s' '{"target":"gh:shepherd","args":[]}' > "$FT_SANDBOX/names.json"
    Data 'acme-org/widgets is here'
    When run script "$FT_REDACT" "$FT_SANDBOX/names.json"
    The status should equal 1
    The stderr should include 'not a names table'
    The output should equal ''
  End

  Describe 'outside the enterprise'
    It 'leaves not one name of the repository under test in the output'
      build_names
      When call survivors
      The status should be success
      The output should equal ''
    End

    It 'replaces owner/name before owner, so the repository is not half-named'
      build_names
      Data "$(sample)"
      When run script "$FT_REDACT" "$FT_SANDBOX/names.json"
      The status should be success
      The output should include '<org>/<repo>'
      The output should not include '<org>/widgets'
    End

    It 'replaces the branch, the commit subject, the path, and the reference'
      build_names
      Data "$(sample)"
      When run script "$FT_REDACT" "$FT_SANDBOX/names.json"
      The status should be success
      The output should include '<branch>'
      The output should include '<commit>'
      The output should include '<path>'
      The output should include '<pr>'
      The output should include '<remote-url>'
    End

    It 'says the run was outside the enterprise, so the shape reads as real'
      build_names
      Data "$(sample)"
      When run script "$FT_REDACT" "$FT_SANDBOX/names.json"
      The status should be success
      The output should include 'outside the plugin'
      The output should include 'The shape of the case is real; the names are not.'
    End

  # A short repository or branch name is a word that also appears inside other
  # words. Replacing it everywhere rewrites the prose until the issue is unreadable,
  # so a value under four characters is replaced only where it stands as a word.
  Describe 'a short name'
    short() {
      ft_fixture_repo "$FT_SANDBOX/target" "acme-org/run" >/dev/null
      "$FT_ISSUE" names "$FT_SANDBOX/target" > "$FT_SANDBOX/names.json"
      printf '%s\n' 'A runner is running in the run directory of acme-org/run.' \
        | "$FT_REDACT" "$FT_SANDBOX/names.json"
    }

    It 'still replaces the name where it stands on its own'
      When call short
      The status should be success
      The output should include 'the <repo> directory'
      The output should include '<org>/<repo>'
    End

    It 'leaves the words it is only a part of alone'
      When call short
      The status should be success
      The output should include 'A runner is running'
    End
  End

    It 'keeps everything that is not a name'
      build_names
      Data "$(sample)"
      When run script "$FT_REDACT" "$FT_SANDBOX/names.json"
      The status should be success
      The output should include 'Checkout at'
      The output should include 'Ran against'
    End
  End

  Describe 'inside the enterprise'
    It 'passes the text through byte for byte'
      build_names
      Data "$(sample)"
      When run script "$FT_REDACT" "$FT_SANDBOX/names.json" --inside
      The status should be success
      The output should equal "$(sample)"
    End

    It 'adds no note about redaction'
      build_names
      Data "$(sample)"
      When run script "$FT_REDACT" "$FT_SANDBOX/names.json" --inside
      The status should be success
      The output should not include 'outside the plugin'
    End
  End
  It 'requires jq'
    export PATH="$(ft_path_without jq)"
    Data 'text'
    When run script "$FT_REDACT" "$FT_SANDBOX/names.json"
    The status should equal 1
    The stderr should include 'jq is required'
  End

End
