# shellcheck shell=bash
# Cross-plugin: every skill must document its flow as a mermaid diagram.
# Globs rather than listing skills, so a new plugin's skills are checked without
# anyone editing this file.
Describe 'skills'
  skill_files() {
    find "$ROOT/plugins" -path '*/skills/*' -name SKILL.md 2>/dev/null | sort
  }

  skills_missing_diagram() {
    local file
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      grep -q '^```mermaid' "$file" || printf '%s\n' "${file#"$ROOT/"}"
    done <<EOF
$(skill_files)
EOF
  }

  It 'finds skills to check'
    # Without this, a glob that matches nothing makes the check below pass
    # vacuously — the exact "green for the wrong reason" failure the rest of
    # this suite exists to prevent.
    When call skill_files
    The status should be success
    The output should include 'SKILL.md'
  End

  It 'documents every skill flow as a mermaid diagram'
    # Required by .claude/rules/file-skill-md.md. A skill's flow is the thing a
    # reader most needs and least wants to reconstruct from prose.
    When call skills_missing_diagram
    The status should be success
    The output should equal ''
  End
End
