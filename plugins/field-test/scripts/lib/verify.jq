# verify.jq — what a field-test report claimed about each pull request, against
# what GitHub says.
#
# Input: null. Arguments: $claims (the report's [{number, claimed}]) and $actual
# ([{number, state, isDraft, error}] read back with gh pr view).
# Output: {ok, checked, matched, mismatches: [...], results: [...]}
#
# This exists because a worker's own report is a claim. The first pass of the
# hardening loop, run by hand, had to be checked pull request by pull request
# against `gh pr view`, and twice the report was wrong. A mismatch here is a
# finding like any other: it goes back through the issue path.
#
# `claimed` is the vocabulary a report uses. Anything outside it is a mismatch
# rather than a pass, because a claim nobody can check is not evidence.

def actual_of($state):
  if $state == "MERGED" then "merged"
  elif $state == "CLOSED" then "closed"
  elif $state == "OPEN" then "open"
  else "unknown" end;

# skipped and open are the same outcome seen from two sides: the pull request is
# still there, untouched, which is what a skip means.
def satisfies($claimed; $actual):
  if $claimed == "merged" then $actual == "merged"
  elif $claimed == "closed" then $actual == "closed"
  elif $claimed == "open" or $claimed == "skipped" then $actual == "open"
  else false end;

def reason($claimed; $actual; $error):
  if $error != "" and $error != null then "could not be read on GitHub: " + $error
  elif ($claimed | IN("merged", "closed", "open", "skipped") | not)
    then "the report used a word this cannot check: " + ($claimed | tostring)
  else "the report said " + $claimed + "; GitHub says " + $actual end;

[ $claims[]
  | . as $c
  | (first($actual[] | select(.number == $c.number)) // {error: "no answer from gh pr view"}) as $a
  | ($a.error // "") as $err
  | (if $err != "" then "unknown" else actual_of($a.state // "") end) as $act
  | {number: $c.number,
     claimed: ($c.claimed // ""),
     actual: $act,
     match: ($err == "" and satisfies(($c.claimed // ""); $act)),
     reason: (if $err == "" and satisfies(($c.claimed // ""); $act) then null
              else reason(($c.claimed // ""); $act; $err) end)} ]
| { ok: (map(.match) | all),
    checked: length,
    matched: (map(select(.match)) | length),
    mismatches: map(select(.match | not)),
    results: . }
