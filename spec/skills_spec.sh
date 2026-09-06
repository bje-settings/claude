# shellcheck shell=bash
# Cross-plugin: every skill documents its flow in a sibling FLOW.md, keeps it out
# of SKILL.md, and spells out the scripts it runs rather than stashing a command
# in a variable. Globs rather than listing skills, so a new plugin's skills are
# checked without anyone editing this file.
Describe 'skills'
  skill_files() {
    find "$ROOT/plugins" -path '*/skills/*' -name SKILL.md 2>/dev/null | sort
  }

  # A skill directory with no FLOW.md beside its SKILL.md.
  skills_without_flow() {
    local file
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      [ -f "$(dirname "$file")/FLOW.md" ] || printf '%s\n' "${file#"$ROOT/"}"
    done <<EOF
$(skill_files)
EOF
  }

  # A FLOW.md that exists but carries no diagram.
  flows_without_diagram() {
    local file flow
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      flow="$(dirname "$file")/FLOW.md"
      [ -f "$flow" ] || continue
      grep -q '^```mermaid' "$flow" || printf '%s\n' "${flow#"$ROOT/"}"
    done <<EOF
$(skill_files)
EOF
  }

  # SKILL.md is loaded on every invocation, so the diagram must not live there.
  skills_carrying_a_diagram() {
    local file
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      grep -q '^```mermaid' "$file" && printf '%s\n' "${file#"$ROOT/"}"
    done <<EOF
$(skill_files)
EOF
    return 0
  }

  # A SKILL.md that holds a command in a variable and expands it as one. zsh does
  # not word-split an unquoted expansion, so `S="bash ...sh"; $S show` looks up the
  # whole string as a command name and exits 127 under the Bash tool's shell.
  # Spell the script out at every call site: bash "${CLAUDE_PLUGIN_ROOT}/scripts/x.sh" show
  skills_hiding_a_command_in_a_variable() {
    local file
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      grep -nE '^[A-Za-z_][A-Za-z0-9_]*="[a-z]+ ' "$file" \
        | sed "s|^|${file#"$ROOT/"}:|"
      # A bare expansion in command position. ${VAR} placeholders inside a path are
      # fine; a lone $VAR starting the line is the idiom this rejects.
      grep -nE '^\$[A-Za-z_][A-Za-z0-9_]* ' "$file" \
        | sed "s|^|${file#"$ROOT/"}:|"
    done <<EOF
$(skill_files)
EOF
    return 0
  }

  It 'finds skills to check'
    # Without this, a glob that matches nothing makes every check below pass
    # vacuously — the "green for the wrong reason" failure this suite exists to
    # prevent.
    When call skill_files
    The status should be success
    The output should include 'SKILL.md'
  End

  It 'gives every skill a FLOW.md beside its SKILL.md'
    When call skills_without_flow
    The status should be success
    The output should equal ''
  End

  It 'puts a mermaid diagram in every FLOW.md'
    When call flows_without_diagram
    The status should be success
    The output should equal ''
  End

  It 'keeps the diagram out of SKILL.md'
    # Required by .claude/rules/file-skill-md.md: SKILL.md is context on every
    # run, FLOW.md is read on demand.
    When call skills_carrying_a_diagram
    The status should be success
    The output should equal ''
  End

  It 'spells out every script a skill runs'
    When call skills_hiding_a_command_in_a_variable
    The status should be success
    The output should equal ''
  End
End
