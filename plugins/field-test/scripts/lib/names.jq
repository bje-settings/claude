# names.jq — the redaction table for one repository under test.
#
# Input: {remote, repo, owner, name, branches[], paths[], refs[], subjects[]}
# Output: {repo, placeholders: [{value, placeholder}]}
#
# `placeholders` is ordered longest value first, which is the whole point of
# building it here rather than in the shell: `owner/name` has to be replaced before
# `owner`, or the result reads `<org>/name` and the repository is still named.
#
# Empty and one-character values are dropped. A one-character branch name would
# match inside every other word in the issue and produce unreadable output, and a
# value that is empty would match everywhere.

def entries($values; $placeholder):
  [ $values[]? | select(type == "string") | select(length > 1) | {value: ., placeholder: $placeholder} ];

{ repo: (if (.repo // "") == "" then null else .repo end),
  placeholders:
    ( entries([.remote]; "<remote-url>")
    + entries([.repo]; "<org>/<repo>")
    + entries(.paths; "<path>")
    + entries(.subjects; "<commit>")
    + entries(.branches; "<branch>")
    + entries(.refs; "<pr>")
    + entries([.owner]; "<org>")
    + entries([.name]; "<repo>")
    | unique_by(.value)
    | sort_by(-(.value | length)) ) }
