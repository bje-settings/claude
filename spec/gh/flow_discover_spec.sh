# shellcheck shell=bash
# /gh:sync and /gh:shepherd resolve their scope through the same library
# (scripts/lib/discover.sh), so their flow diagrams describe it with one shared
# `discover` subgraph. Drift between the two copies would mean one diagram is
# lying about how scope is decided.
Describe 'gh flow diagrams'
  SKILLS="$ROOT/plugins/gh/skills"

  # The `subgraph discover ... end` block of one FLOW.md, indentation stripped
  # so only the content is compared.
  discover_block() {
    sed -n '/^ *subgraph discover /,/^ *end$/p' "$SKILLS/$1/FLOW.md" | sed 's/^ *//'
  }

  It 'draws a discover subgraph in the sync diagram'
    When call discover_block sync
    The status should be success
    The output should include 'Inside a git repo?'
    The output should include 'Skipped silently'
    The output should include 'Stop: no git repositories directly inside cwd'
  End

  It 'draws a discover subgraph in the shepherd diagram'
    When call discover_block shepherd
    The status should be success
    The output should include 'Inside a git repo?'
    The output should include 'Skipped silently'
    The output should include 'Stop: no git repositories directly inside cwd'
  End

  It 'keeps the two discover subgraphs identical'
    When call diff <(discover_block sync) <(discover_block shepherd)
    The status should be success
    The output should equal ''
  End
End
