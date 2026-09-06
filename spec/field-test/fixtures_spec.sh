# shellcheck shell=bash
# The other specs in this directory read claims off these fixtures: that a repo has
# this branch, that an events file holds an unresolved failure, that the deny list
# has a sample on each side of every pattern. Asserting those claims here is what
# stops the rest of the suite passing for the wrong reason.
Describe 'field-test fixtures'
  BeforeEach 'setup_ft_sandbox'
  AfterEach 'cleanup_ft_sandbox'

  Describe 'ft_fixture_repo'
    It 'builds a repository with two branches and the stated commit subjects'
      shape() {
        ft_fixture_repo "$FT_SANDBOX/r" acme-org/widgets >/dev/null
        printf '%s|%s|%s' \
          "$(ft_fixture_git "$FT_SANDBOX/r" for-each-ref --format='%(refname:short)' refs/heads/ | sort | tr '\n' ',')" \
          "$(ft_fixture_git "$FT_SANDBOX/r" log --format='%s' | tr '\n' ',')" \
          "$(ft_fixture_git "$FT_SANDBOX/r" remote get-url origin)"
      }
      When call shape
      The status should be success
      The output should equal 'main,wktr-9-widget-fix,|fix: the widget drops its last field,feat: the first commit subject,|git@github.com:acme-org/widgets.git'
    End

    It 'writes an https remote when asked for one'
      remote() { ft_fixture_repo "$FT_SANDBOX/r" acme-org/widgets https >/dev/null; ft_fixture_git "$FT_SANDBOX/r" remote get-url origin; }
      When call remote
      The status should be success
      The output should equal 'https://github.com/acme-org/widgets.git'
    End

    It 'leaves the repository without a remote when asked for none'
      remote() { ft_fixture_repo "$FT_SANDBOX/r" acme-org/widgets none >/dev/null; ft_fixture_git "$FT_SANDBOX/r" remote; }
      When call remote
      The status should be success
      The output should equal ''
    End
  End

  Describe 'ft_fixture_events'
    kinds() { ft_fixture_events "$FT_SANDBOX/e.jsonl" "$1"; jq -rs '[.[].event] | join(" ")' "$FT_SANDBOX/e.jsonl"; }

    It 'gives the clean case two successful Bash calls and nothing else'
      When call kinds clean
      The status should be success
      The output should equal 'PostToolUse PostToolUse'
    End

    It 'gives the nonzero case the same failing command twice, on different numbers'
      commands() {
        ft_fixture_events "$FT_SANDBOX/e.jsonl" nonzero
        jq -rs '[.[] | select(.exit_code == 1) | .command] | join("|")' "$FT_SANDBOX/e.jsonl"
      }
      When call commands
      The status should be success
      The output should equal 'gh pr merge --auto --squash 11|gh pr merge --auto --squash 12'
    End

    It 'gives the failure case a tool call that failed outright'
      shape() {
        ft_fixture_events "$FT_SANDBOX/e.jsonl" failure
        jq -rs '[.[] | [.event, (.exit_code | tostring)] | join(":")] | join(" ")' "$FT_SANDBOX/e.jsonl"
      }
      When call shape
      The status should be success
      The output should equal 'PostToolUseFailure:127'
    End

    It 'gives the denied case a command the hook refused, with its reason'
      shape() {
        ft_fixture_events "$FT_SANDBOX/e.jsonl" denied
        jq -rs '[.[] | select(.event == "denied") | .command] | join(" ")' "$FT_SANDBOX/e.jsonl"
      }
      When call shape
      The status should be success
      The output should equal 'git push --force origin main'
    End

    It 'gives the args-used case a call that carries --dry-run'
      shape() {
        ft_fixture_events "$FT_SANDBOX/e.jsonl" args-used
        jq -rs '[.[] | select(.command | test("--dry-run"))] | length' "$FT_SANDBOX/e.jsonl"
      }
      When call shape
      The status should be success
      The output should equal '1'
    End

    It 'gives the preceding case five calls before the failure, one running none'
      shape() {
        ft_fixture_events "$FT_SANDBOX/e.jsonl" preceding
        jq -rs '[.[] | .command // "-"] | join(" ")' "$FT_SANDBOX/e.jsonl"
      }
      When call shape
      The status should be success
      The output should equal 'git fetch origin git status --short gh pr list --state open gh pr checks 11 - gh pr merge --auto --squash 11'
    End

    It 'gives the null-agent case a claim and a failure with no subagent id'
      shape() {
        ft_fixture_events "$FT_SANDBOX/e.jsonl" null-agent
        jq -rs '[.[] | .agent_id | tojson] | join(" ")' "$FT_SANDBOX/e.jsonl"
      }
      When call shape
      The status should be success
      The output should equal 'null null'
    End

    It 'gives the hook-error case a hook that raised and a call that still ran'
      shape() {
        ft_fixture_events "$FT_SANDBOX/e.jsonl" hook-error
        jq -rs '[.[] | .event] | join(" ")' "$FT_SANDBOX/e.jsonl"
      }
      When call shape
      The status should be success
      The output should equal 'hook_error PostToolUse'
    End

    It 'gives the no-command case a null command and an empty one'
      shape() {
        ft_fixture_events "$FT_SANDBOX/e.jsonl" no-command
        jq -rs '[.[] | .command | tojson] | join(" ")' "$FT_SANDBOX/e.jsonl"
      }
      When call shape
      The status should be success
      The output should equal 'null "" "git push --force origin main"'
    End

    It 'gives the contradiction case a failure the subagent never resolved'
      shape() {
        ft_fixture_events "$FT_SANDBOX/e.jsonl" contradiction
        jq -rs '[.[] | select(.agent_id == "agent-1")] | [(map(select(.exit_code == 1)) | length), (map(select(.exit_code == 0)) | length)] | join(",")' "$FT_SANDBOX/e.jsonl"
      }
      When call shape
      The status should be success
      The output should equal '1,0'
    End

    It 'gives the retried case the same command succeeding afterwards'
      shape() {
        ft_fixture_events "$FT_SANDBOX/e.jsonl" retried
        jq -rs '[.[] | select(.command == "bash spec/run.sh") | .exit_code] | join(",")' "$FT_SANDBOX/e.jsonl"
      }
      When call shape
      The status should be success
      The output should equal '1,0'
    End

    It 'gives the status-ok case a subagent reporting a status that is not failed'
      claim() {
        ft_fixture_events "$FT_SANDBOX/e.jsonl" status-ok
        jq -rs '.[] | select(.event == "SubagentStop") | .last_assistant_message' "$FT_SANDBOX/e.jsonl"
      }
      When call claim
      The status should be success
      The output should include '"status": "ok"'
    End

    It 'gives the deny-error case a rule that did not compile beside a normal call'
      shape() {
        ft_fixture_events "$FT_SANDBOX/e.jsonl" deny-error
        jq -rs '[.[] | select(.event == "deny_list_error") | .pattern] | join(",")' "$FT_SANDBOX/e.jsonl"
      }
      When call shape
      The status should be success
      The output should equal '[unclosed'
    End

    It 'gives the honest case a subagent that reports failed'
      claim() {
        ft_fixture_events "$FT_SANDBOX/e.jsonl" honest
        jq -rs '.[] | select(.event == "SubagentStop") | .last_assistant_message' "$FT_SANDBOX/e.jsonl"
      }
      When call claim
      The status should be success
      The output should include '"status": "failed"'
    End

    It 'gives the mixed case one event of every kind the collector can raise'
      When call kinds mixed
      The status should be success
      The output should equal 'PostToolUse PostToolUse PostToolUseFailure denied SubagentStop'
    End

    It 'refuses a case it does not have, rather than writing an empty file'
      When call ft_fixture_events "$FT_SANDBOX/e.jsonl" nosuchcase
      The status should equal 1
      The stderr should include 'unknown case'
    End
  End

  Describe 'the deny and allow samples'
    # Every pattern in hooks/deny-list.txt needs a sample on each side, or a pattern
    # could be narrowed to nothing and the suite would stay green.
    unexercised() {
      python3 - "$FT_DENY_LIST_FILE" "$FT_FIXTURES_DIR/commands/deny.txt" <<'PY'
import re, sys
patterns = [l.strip() for l in open(sys.argv[1]) if l.strip() and not l.strip().startswith("#")]
commands = [l.rstrip("\n") for l in open(sys.argv[2]) if l.strip()]
for p in patterns:
    if not any(re.search(p, c) for c in commands):
        print(p)
PY
    }

    It 'has a denied sample for every pattern in the list'
      When call unexercised
      The status should be success
      The output should equal ''
    End

    It 'has more than one pattern to check, so the check is not vacuous'
      count() { grep -c -v -e '^#' -e '^$' "$FT_DENY_LIST_FILE"; }
      When call count
      The status should be success
      The output should equal '5'
    End

    # Empty allow.txt and hook_spec.sh's 'allows every command the list is careful not
    # to name' passes without checking anything, which is the only guard against a
    # pattern that matches too much.
    It 'has near misses to check the patterns against'
      allow_count() { grep -c . "$FT_FIXTURES_DIR/commands/allow.txt"; }
      When call allow_count
      The status should be success
      The output should equal '20'
    End
  End

  Describe 'ft_fixture_issues and the gh stub'
    It 'serves one open field-test issue carrying the signature the specs search for'
      matches() {
        gh issue list --repo acme-org/plugins --state open --label field-test \
          --search 'bash_nonzero:gh pr merge --auto --squash N' --json number \
          --jq '[.[].number] | join(",")'
      }
      When call matches
      The status should be success
      The output should equal '40'
    End

    It 'serves an open field-test issue whose signature holds quotes'
      matches() {
        gh issue list --repo acme-org/plugins --state open --label field-test \
          --search 'bash_nonzero:gh pr comment -b "done" N' --json number \
          --jq '[.[].number] | join(",")'
      }
      When call matches
      The status should be success
      The output should equal '44'
    End

    It 'keeps a closed issue with the same signature out of the open set'
      closed() { gh issue list --repo acme-org/plugins --state closed --json number --jq '[.[].number] | join(",")'; }
      When call closed
      The status should be success
      The output should equal '42'
    End

    It 'refuses a flag it does not emulate, so a spec cannot pass on a fake answer'
      When run command gh issue list --repo acme-org/plugins --author someone
      The status should equal 64
      The stderr should include 'unhandled flag'
    End

    It 'refuses a subcommand it does not emulate'
      When run command gh pr merge 11
      The status should equal 1
      The stderr should include 'unsupported'
    End

    It 'refuses an unknown --json field the way gh does'
      When run command gh issue list --repo acme-org/plugins --json nosuchfield
      The status should equal 1
      The stderr should include 'Unknown JSON field'
    End

    It 'answers the enterprise query with both organizations by default'
      logins() { gh api graphql -f query='query { viewer { enterprises { nodes { slug } } } }' | jq -r '[.data.viewer.enterprises.nodes[0].organizations.nodes[].login] | join(",")'; }
      When call logins
      The status should be success
      The output should equal 'acme-org,acme-tools'
    End

    It 'holds the second organization back for the second page in the paged case'
      ft_fixture_enterprise "$FT_GH_FIXTURE_DIR" paged
      first() { gh api graphql -f query='query { viewer { enterprises { nodes { slug } } } }' | jq -rc '[.data.viewer.enterprises.nodes[0].organizations | (.pageInfo.hasNextPage | tostring), (.nodes[].login)] | join(",")'; }
      When call first
      The status should be success
      The output should equal 'true,acme-org'
    End

    It 'fails every call when told to'
      export FT_GH_FIXTURE_FAIL=1
      When run command gh api graphql -f query='query { viewer { login } }'
      The status should equal 1
      The stderr should include 'simulated failure'
    End
  End

  Describe 'ft_fixture_run and the registry fixtures'
    It 'writes a marker the scripts accept, with no finish time'
      shape() { ft_fixture_run "$FT_SANDBOX/run.json"; jq -r '[.version, .target, (.finished_at | tostring)] | join("|")' "$FT_SANDBOX/run.json"; }
      When call shape
      The status should be success
      The output should equal '1|gh:shepherd|null'
    End

    It 'lays the installed plugin out with the skill file the resolver looks for'
      When call test -f "$FT_INSTALL_DIR/skills/shepherd/SKILL.md"
      The status should be success
    End

    It 'omits the skill file when asked to'
      shape() {
        ft_fixture_installed_plugins "$FT_INSTALLED_PLUGINS" "$FT_SANDBOX/other" without-skill
        test -e "$FT_SANDBOX/other/skills/shepherd/SKILL.md"
      }
      When call shape
      The status should equal 1
    End

    It 'names the marketplace source as a directory by default'
      source_of() { jq -r '.bje.source.source' "$FT_MARKETPLACES"; }
      When call source_of
      The status should be success
      The output should equal 'directory'
    End
  End

  Describe 'ft_fixture_hook_input and ft_fixture_transcript'
    It 'gives the failure payload no tool_response, the way the real event has none'
      shape() {
        ft_fixture_hook_input "$FT_SANDBOX/p.json" post-failure
        jq -r '[(.tool_response | tojson), .error] | join(" | ")' "$FT_SANDBOX/p.json"
      }
      When call shape
      The status should be success
      The output should include 'null | Exit code 127'
    End

    It 'refuses a hook payload case it does not have'
      When call ft_fixture_hook_input "$FT_SANDBOX/p.json" nosuchcase
      The status should equal 1
      The stderr should include 'unknown case'
    End

    It 'refuses a transcript case it does not have'
      When call ft_fixture_transcript "$FT_SANDBOX/t.jsonl" nosuchcase
      The status should equal 1
      The stderr should include 'unknown case'
    End

    It 'writes a transcript whose last assistant turn carries no text of its own'
      tail_kinds() {
        ft_fixture_transcript "$FT_SANDBOX/t.jsonl" tool-tail
        jq -rs 'last.message.content | map(.type) | join(",")' "$FT_SANDBOX/t.jsonl"
      }
      When call tail_kinds
      The status should be success
      The output should equal 'thinking,tool_use'
    End

    It 'writes a transcript whose last assistant turn is the report'
      last() {
        ft_fixture_transcript "$FT_SANDBOX/t.jsonl" with-report
        jq -rs 'map(select(.type == "assistant")) | last.message.content[0].text' "$FT_SANDBOX/t.jsonl"
      }
      When call last
      The status should be success
      The output should include '| #11 | merged |'
    End
  End
  Describe 'ft_fixture_prs and ft_fixture_report'
    It 'covers every check verdict the wait script can reach'
      verdicts() {
        local n
        for n in 50 51 52 53 56 57 59 60; do
          gh pr view "$n" --repo acme-org/plugins --json state,isDraft,statusCheckRollup \
            | jq -r -f "$FT_PLUGIN_DIR/scripts/lib/checks.jq" \
            | jq -r '.checks'
        done | tr '\n' ' '
      }
      When call verdicts
      The status should be success
      The output should equal 'pass fail pending none pending fail fail fail '
    End

    It 'has one merged and one closed pull request for the state arms'
      states() {
        gh pr view 54 --repo acme-org/plugins --json state --jq .state
        gh pr view 55 --repo acme-org/plugins --json state --jq .state
      }
      When call states
      The status should be success
      The output should equal 'MERGED
CLOSED'
    End

    It 'moves a sequenced pull request from in progress to complete across calls, and stays there'
      poll() {
        gh pr view 58 --repo acme-org/plugins --json statusCheckRollup --jq '.statusCheckRollup[0].status'
        gh pr view 58 --repo acme-org/plugins --json statusCheckRollup --jq '.statusCheckRollup[0].status'
        gh pr view 58 --repo acme-org/plugins --json statusCheckRollup --jq '.statusCheckRollup[0].status'
      }
      When call poll
      The status should be success
      The output should equal 'IN_PROGRESS
COMPLETED
COMPLETED'
    End

    It 'has a pull request with no checks on the first look and a run on the next'
      poll() {
        gh pr view 61 --repo acme-org/plugins --json statusCheckRollup --jq '.statusCheckRollup | length'
        gh pr view 61 --repo acme-org/plugins --json statusCheckRollup --jq '.statusCheckRollup | length'
      }
      When call poll
      The status should be success
      The output should equal '0
1'
    End

    It 'refuses a pull request it does not have, the way gh does'
      When run command gh pr view 999 --repo acme-org/plugins --json state
      The status should equal 1
      The stderr should include 'Could not resolve to a PullRequest'
    End

    It 'writes an accurate report whose every claim holds'
      claims() { ft_fixture_report "$FT_SANDBOX/r.json" accurate; jq -r '[.prs[] | .claimed] | join(",")' "$FT_SANDBOX/r.json"; }
      When call claims
      The status should be success
      The output should equal 'merged,skipped,closed'
    End

    It 'refuses a report case it does not have'
      When call ft_fixture_report "$FT_SANDBOX/r.json" nosuchcase
      The status should equal 1
      The stderr should include 'unknown case'
    End
  End

End
