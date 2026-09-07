# shellcheck shell=bash
# Every example runs the script through `When run script` so kcov traces it; the
# helpers only read the resulting state file back.
Describe 'ft-harden-state.sh'
  BeforeEach 'setup_ft_sandbox'
  AfterEach 'cleanup_ft_sandbox'

  STATE_FILE() { printf '%s/harden/gh__shepherd.json' "$FT_STATE_DIR"; }
  start_run() { "$FT_HARDEN_STATE" init gh:shepherd "$@" >/dev/null; }
  add() { "$FT_HARDEN_STATE" add-target gh:shepherd "$@" >/dev/null; }
  one_target() { start_run; add /repos/widgets; }
  two_targets() { start_run; add /repos/widgets; add /repos/gadgets; }
  target() { jq -c ".targets[$1]" "$(STATE_FILE)"; }
  field() { jq -r ".targets[0].$1" "$(STATE_FILE)"; }
  count() { jq '.targets | length' "$(STATE_FILE)"; }

  Describe 'location'
    It 'derives the path from the skill under the state dir'
      When run script "$FT_HARDEN_STATE" path gh:shepherd
      The status should be success
      The output should equal "$(STATE_FILE)"
    End

    It 'falls back to CLAUDE_PLUGIN_DATA when FT_STATE_DIR is unset'
      unset FT_STATE_DIR
      export CLAUDE_PLUGIN_DATA="$FT_SANDBOX/data"
      When run script "$FT_HARDEN_STATE" path gh:shepherd
      The status should be success
      The output should equal "$FT_SANDBOX/data/harden/gh__shepherd.json"
    End

    It 'refuses to guess a location when neither is set'
      unset FT_STATE_DIR
      When run script "$FT_HARDEN_STATE" path gh:shepherd
      The status should equal 2
      The stderr should include 'CLAUDE_PLUGIN_DATA'
    End

    It 'needs a target skill'
      When run script "$FT_HARDEN_STATE" path
      The status should equal 2
      The stderr should include 'needs a <plugin:skill> target'
    End

    It 'rejects a target that is not plugin:skill'
      When run script "$FT_HARDEN_STATE" path shepherd
      The status should equal 2
      The stderr should include 'must be plugin:skill'
    End
  End

  Describe 'usage'
    It 'prints usage for --help'
      When run script "$FT_HARDEN_STATE" --help
      The status should be success
      The output should include 'ft-harden-state.sh init'
    End

    It 'exits 2 with usage when given no command'
      When run script "$FT_HARDEN_STATE"
      The status should equal 2
      The stderr should include 'ft-harden-state.sh init'
    End

    It 'rejects an unknown command'
      When run script "$FT_HARDEN_STATE" restart gh:shepherd
      The status should equal 2
      The stderr should include 'unknown command: restart'
    End

    It 'requires jq'
      export PATH="$(ft_path_without jq)"
      When run script "$FT_HARDEN_STATE" path gh:shepherd
      The status should equal 1
      The stderr should include 'jq is required'
    End
  End

  Describe 'init'
    It 'writes an empty run sized opus and high by default'
      When run script "$FT_HARDEN_STATE" init gh:shepherd
      The status should be success
      The output should equal "$(STATE_FILE)"
      The value "$(jq -r '[.version, .skill, .model, .effort, (.targets | length | tostring)] | join("|")' "$(STATE_FILE)")" should equal '1|gh:shepherd|opus|high|0'
    End

    It 'takes a model and effort'
      When run script "$FT_HARDEN_STATE" init gh:shepherd --model sonnet --effort medium
      The status should be success
      The output should include 'gh__shepherd.json'
      The value "$(jq -r '.model + "/" + .effort' "$(STATE_FILE)")" should equal 'sonnet/medium'
    End

    It 'rejects a model outside the list'
      When run script "$FT_HARDEN_STATE" init gh:shepherd --model gpt
      The status should equal 2
      The stderr should include 'model must be one of'
    End

    It 'rejects an effort outside the list'
      When run script "$FT_HARDEN_STATE" init gh:shepherd --effort extreme
      The status should equal 2
      The stderr should include 'effort must be low, medium, or high'
    End

    It 'rejects an unknown argument'
      When run script "$FT_HARDEN_STATE" init gh:shepherd --resume
      The status should equal 2
      The stderr should include 'unknown argument: --resume'
    End

    It 'rejects a flag with no value'
      When run script "$FT_HARDEN_STATE" init gh:shepherd --model
      The status should equal 2
      The stderr should include '--model needs a value'
    End

    It 'refuses to throw away a run in progress'
      one_target
      When run script "$FT_HARDEN_STATE" init gh:shepherd
      The status should equal 3
      The stderr should include '--force to start over'
      The value "$(count)" should equal '1'
    End

    It 'starts over with --force'
      one_target
      When run script "$FT_HARDEN_STATE" init gh:shepherd --force
      The status should be success
      The output should include 'gh__shepherd.json'
      The value "$(count)" should equal '0'
    End

    It 'reports a state directory it cannot create'
      : > "$FT_SANDBOX/blocked"
      export FT_STATE_DIR="$FT_SANDBOX/blocked"
      When run script "$FT_HARDEN_STATE" init gh:shepherd
      The status should equal 1
      The stderr should include 'cannot create'
    End
  End

  Describe 'add-target'
    BeforeEach 'start_run'

    It 'appends a target ready for its first phase'
      When run script "$FT_HARDEN_STATE" add-target gh:shepherd /repos/widgets --repo acme-org/widgets
      The status should be success
      The value "$(target 0)" should include '"status":"pending"'
      The value "$(target 0)" should include '"phase":"field-test"'
      The value "$(target 0)" should include '"review_rounds":0'
      The value "$(field 'repo')" should equal 'acme-org/widgets'
    End

    It 'keeps the order it was given, because the order is the plan'
      add /repos/widgets
      When run script "$FT_HARDEN_STATE" add-target gh:shepherd /repos/gadgets
      The status should be success
      The value "$(jq -r '[.targets[].path] | join(",")' "$(STATE_FILE)")" should equal '/repos/widgets,/repos/gadgets'
    End

    It 'ignores a path that is already listed rather than duplicating it'
      add /repos/widgets
      When run script "$FT_HARDEN_STATE" add-target gh:shepherd /repos/widgets
      The status should be success
      The value "$(count)" should equal '1'
    End

    It 'leaves the repo null when it was not given one'
      When run script "$FT_HARDEN_STATE" add-target gh:shepherd /repos/widgets
      The status should be success
      The value "$(field 'repo')" should equal 'null'
    End

    It 'needs a path'
      When run script "$FT_HARDEN_STATE" add-target gh:shepherd
      The status should equal 2
      The stderr should include 'needs a repository path'
    End

    It 'rejects an unknown argument'
      When run script "$FT_HARDEN_STATE" add-target gh:shepherd /repos/widgets --now
      The status should equal 2
      The stderr should include 'unknown argument: --now'
    End

    It 'refuses before init, rather than writing a state file of its own'
      rm -f "$(STATE_FILE)"
      When run script "$FT_HARDEN_STATE" add-target gh:shepherd /repos/widgets
      The status should equal 1
      The stderr should include 'run init first'
    End

    It 'refuses a state file that is not field-test JSON'
      printf '{"nope": true}' > "$(STATE_FILE)"
      When run script "$FT_HARDEN_STATE" add-target gh:shepherd /repos/widgets
      The status should equal 1
      The stderr should include 'not valid field-test JSON'
    End
  End

  Describe 'set'
    BeforeEach 'one_target'

    It 'records a phase transition'
      When run script "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets phase fix
      The status should be success
      The value "$(field 'phase')" should equal 'fix'
    End

    It 'stores the pull request as a number without being told'
      When run script "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets pr 44
      The status should be success
      The value "$(jq -c '.targets[0].pr' "$(STATE_FILE)")" should equal '44'
    End

    It 'clears the pull request back to null'
      "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets pr 44
      When run script "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets pr null
      The status should be success
      The value "$(jq -c '.targets[0].pr' "$(STATE_FILE)")" should equal 'null'
    End

    It 'rejects a pull request that is not a number'
      When run script "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets pr forty-four
      The status should equal 2
      The stderr should include 'pr takes a number or null'
    End

    # The review phase hands the round to /workstreams:review and records which
    # round it was, so a resumed run knows whether the round it is starting is
    # the one repeat the round rule allows. A count stored as a string would
    # compare wrong against that limit rather than fail.
    It 'stores the review round as a number and refuses one that is not'
      "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets review_rounds 2
      When run script "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets review_rounds two
      The status should equal 2
      The stderr should include 'review_rounds takes a number or null'
      The value "$(jq -c '.targets[0].review_rounds' "$(STATE_FILE)")" should equal '2'
    End

    It 'stores the issues as a JSON array'
      When run script "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets issues '[25,32]'
      The status should be success
      The value "$(jq -c '.targets[0].issues' "$(STATE_FILE)")" should equal '[25,32]'
    End

    It 'rejects invalid JSON and leaves the target alone'
      When run script "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets issues '[25,'
      The status should equal 2
      The stderr should include 'not valid JSON'
      The value "$(jq -c '.targets[0].issues' "$(STATE_FILE)")" should equal '[]'
    End

    It 'validates the status'
      When run script "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets status finished
      The status should equal 2
      The stderr should include 'invalid status'
    End

    It 'validates the phase'
      When run script "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets phase merging
      The status should equal 2
      The stderr should include 'invalid phase'
    End

    It 'rejects a field outside the schema, so a typo cannot create one'
      When run script "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets stauts done
      The status should equal 2
      The stderr should include 'unknown field: stauts'
    End

    It 'rejects a fourth argument other than --json'
      When run script "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets summary text --force
      The status should equal 2
      The stderr should include 'unknown argument: --force'
    End

    It 'needs three arguments'
      When run script "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets status
      The status should equal 2
      The stderr should include 'set needs'
    End

    It 'rejects two statuses in one value, which would match the list and be skipped by next'
      When run script "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets status 'pending done'
      The status should equal 2
      The stderr should include 'invalid status'
    End

    It 'rejects a phase with a space in it'
      When run script "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets phase 'fix review'
      The status should equal 2
      The stderr should include 'invalid phase'
    End

    It 'rejects issues that are valid JSON but not an array'
      When run script "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets issues '{"a": 1}'
      The status should equal 2
      The stderr should include 'issues takes a JSON array'
    End

    It 'fails for a target that was never added'
      When run script "$FT_HARDEN_STATE" set gh:shepherd /repos/gadgets status done
      The status should equal 1
      The stderr should include 'unknown target'
    End

    It 'leaves no temp file behind'
      "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets status running
      leftovers() { find "$FT_STATE_DIR/harden" -name '*.tmp.*' | wc -l | tr -d ' '; }
      When call leftovers
      The status should be success
      The output should equal '0'
    End

    It 'keeps the old state when the update cannot be written'
      chmod a-w "$FT_STATE_DIR/harden"
      When run script "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets status done
      The status should equal 1
      The stderr should include 'cannot write'
      The value "$(field 'status')" should equal 'pending'
    End
  End

  Describe 'bump'
    BeforeEach 'one_target'

    # The review phase counts a round with bump rather than writing a number it
    # worked out itself: a session that stopped mid-round and one starting the
    # repeat would otherwise both have to agree on what the count already was.
    It 'adds one to the review round and prints the new value'
      When run script "$FT_HARDEN_STATE" bump gh:shepherd /repos/widgets review_rounds
      The status should be success
      The output should equal '1'
      The value "$(field review_rounds)" should equal '1'
    End

    It 'counts on from the round already recorded'
      "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets review_rounds 1
      When run script "$FT_HARDEN_STATE" bump gh:shepherd /repos/widgets review_rounds
      The status should be success
      The output should equal '2'
    End

    # Its own message, not set's: a caller sent to set's field list goes looking
    # through nine fields, seven of which bump would refuse anyway.
    It 'names itself when the field is not one it can count'
      When run script "$FT_HARDEN_STATE" bump gh:shepherd /repos/widgets status
      The status should equal 2
      The stderr should include 'bump: unknown field: status'
      The stderr should include 'pr review_rounds'
    End

    It 'refuses a value it cannot count from and leaves it alone'
      jq '.targets[0].review_rounds = "two"' "$(STATE_FILE)" > "$FT_SANDBOX/edited.json"
      mv "$FT_SANDBOX/edited.json" "$(STATE_FILE)"
      When run script "$FT_HARDEN_STATE" bump gh:shepherd /repos/widgets review_rounds
      The status should equal 1
      The stderr should include 'bump: review_rounds is not a number: two'
      The value "$(field review_rounds)" should equal 'two'
    End

    It 'refuses a target that is not in the run'
      When run script "$FT_HARDEN_STATE" bump gh:shepherd /repos/nothing review_rounds
      The status should equal 1
      The stderr should include 'bump: unknown target: /repos/nothing'
    End

    It 'needs a path and a field'
      When run script "$FT_HARDEN_STATE" bump gh:shepherd /repos/widgets
      The status should equal 2
      The stderr should include 'bump needs <path> <numeric-field>'
    End
  End

  Describe 'next and show'
    BeforeEach 'two_targets'

    It 'prints the first target still to do'
      When run script "$FT_HARDEN_STATE" next gh:shepherd
      The status should be success
      The output should equal '/repos/widgets'
    End

    It 'moves on once a target is done'
      "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets status done
      When run script "$FT_HARDEN_STATE" next gh:shepherd
      The status should be success
      The output should equal '/repos/gadgets'
    End

    It 'steps over a target that failed'
      "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets status failed
      When run script "$FT_HARDEN_STATE" next gh:shepherd
      The status should be success
      The output should equal '/repos/gadgets'
    End

    It 'returns a target still running, so a session that stopped mid-target resumes it'
      "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets status running
      When run script "$FT_HARDEN_STATE" next gh:shepherd
      The status should be success
      The output should equal '/repos/widgets'
    End

    It 'still returns a paused target, so its question is not stepped over'
      "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets status paused
      When run script "$FT_HARDEN_STATE" next gh:shepherd
      The status should be success
      The output should equal '/repos/widgets'
    End

    It 'prints nothing when every target is finished'
      "$FT_HARDEN_STATE" set gh:shepherd /repos/widgets status done
      "$FT_HARDEN_STATE" set gh:shepherd /repos/gadgets status done
      When run script "$FT_HARDEN_STATE" next gh:shepherd
      The status should be success
      The output should equal ''
    End

    It 'rejects an argument after next'
      When run script "$FT_HARDEN_STATE" next gh:shepherd --all
      The status should equal 2
      The stderr should include 'unknown argument: --all'
    End

    It 'pretty-prints the whole run'
      When run script "$FT_HARDEN_STATE" show gh:shepherd
      The status should be success
      The output should include '"skill": "gh:shepherd"'
      The output should include '"path": "/repos/widgets"'
    End

    It 'refuses to show a run that does not exist'
      When run script "$FT_HARDEN_STATE" show workstreams:run
      The status should equal 1
      The stderr should include 'run init first'
    End
  End
End
