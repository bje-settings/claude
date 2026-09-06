#!/usr/bin/env python3
"""ws-issues.py: resolve issue selectors to one JSON array of issues.

  ws-issues.py <selector>...

Selectors, in any mix:
  12  #12  10-14        issue numbers and inclusive ranges, up to the limit wide
  label:<name>          open issues carrying the label
  milestone:<title>     open issues in the milestone
  anything else         joined into one `gh issue list --search` query
                        (each such selector is reported on stderr)

Output is sorted by number with duplicates removed. Each issue carries number,
title, body, state, url, labels (names only), and refs: the other issue numbers
mentioned as #N in its body, for the skill's blocked-on analysis. A number that
turns out to be a pull request is an error, not an issue.

Exit 0 with issues, 3 when nothing matched (stdout is still `[]`), 2 on usage,
1 when gh fails. Deterministic: no judgment lives here.

Overridable for tests:
  WS_ISSUE_LIMIT   the --limit one `gh issue list` is given, and the widest
                   range one selector may name (default: 200)
"""

# Stdlib only, Python 3.9: an end user runs this with the python3 macOS ships.
# It lives here rather than in the docstring above, which is what `--help`
# prints and is addressed to whoever is running the script, not editing it.

from __future__ import annotations

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from lib import cli  # noqa: E402  (needs HERE on sys.path first)
from lib import issues as iss  # noqa: E402  (same)

PROG = "ws-issues.py"

# What every gh call asks for, so a list and a view answer with the same shape.
FIELDS = "number,title,body,state,url,labels"
DEFAULT_LIMIT = str(iss.DEFAULT_LIMIT)


def die(message: str, status: int = 1):
    raise cli.Failure(message, status)


def limit() -> str:
    """The --limit to give gh, as text: whatever it is, gh is the one that judges it."""
    return os.environ.get("WS_ISSUE_LIMIT") or DEFAULT_LIMIT


def range_cap() -> int:
    """The widest range a selector may name: the limit, when it is a number.

    A WS_ISSUE_LIMIT gh would refuse is still gh's to refuse, so the range
    check falls back to the default rather than guessing at what was meant.
    """
    try:
        cap = int(limit())
    except ValueError:
        return iss.DEFAULT_LIMIT
    return cap if cap > 0 else iss.DEFAULT_LIMIT


def gh_json(arguments, failure: str):
    """One gh call, answering with parsed JSON or raising with `failure`.

    Only stdout is captured. gh writes progress, warnings and its own errors to
    stderr, and that stream is left alone so whoever ran the skill sees the real
    reason a call failed rather than this script's one-line summary of it.
    """
    try:
        finished = subprocess.run(["gh", *arguments], stdout=subprocess.PIPE, check=False)
    except OSError as error:
        die(f"{failure}: {error}")
    if finished.returncode != 0:
        die(failure)
    text = finished.stdout.decode("utf-8", "replace")
    try:
        return json.loads(text)
    except ValueError as error:
        die(f"{failure}: gh answered with something that is not JSON ({error})")


def gh_list(flag: str, value: str, label: str):
    """One `gh issue list` call, warning when it saturates the limit.

    A list that comes back exactly `--limit` long is one GitHub may have cut
    short. The script cannot tell, so it says so and carries on rather than
    silently planning around a set of issues that is missing members.
    """
    cap = limit()
    answer = gh_json(
        ["issue", "list", "--state", "open", "--limit", cap, flag, value, "--json", FIELDS],
        f"gh issue list failed for {label}",
    )
    if str(len(answer)) == cap:
        sys.stderr.write(
            f"{PROG}: warning: {label} returned {cap} issues, the limit; some may be missing\n"
        )
    return answer


def gh_view(number: int):
    """One `gh issue view` call, refusing a number that turns out to be a PR.

    `gh issue view 7` answers for a pull request too, since GitHub numbers the
    two together. Planning work on one would produce a stream with nothing to
    do, so it is an error here rather than something the skill has to notice.
    """
    answer = gh_json(
        ["issue", "view", str(number), "--json", FIELDS],
        f"gh issue view failed for #{number}",
    )
    if not isinstance(answer, dict):
        # Not a shape to carry on with: the pull-request check below would find
        # no url on it and wave through whatever it is, and the merge would
        # then look for a number that is not there either.
        die(f"gh issue view answered with something other than an issue for #{number}")
    if "/pull/" in str(answer.get("url") or ""):
        die(f"#{number} is a pull request, not an issue")
    return answer


def resolve(selectors):
    """Every selector turned into gh answers, in the order the shell asked in.

    Lists go out as they are read, then the numbers, then one search built from
    everything left over. The order decides only which duplicate is kept, and
    the merge keeps the first.
    """
    answers = []
    numbers = []
    search = []
    cap = range_cap()
    for selector in selectors:
        kind, payload = iss.classify(selector, cap)
        if kind == "list":
            answers.append(gh_list(payload[0], payload[1], selector))
        elif kind == "numbers":
            numbers.extend(payload)
        else:
            # Said out loud: a mistyped selector becoming a search that quietly
            # matches nothing is the confusing failure this warning prevents.
            sys.stderr.write(f"{PROG}: treating as search text: {selector}\n")
            search.append(selector)
    for number in numbers:
        answers.append(gh_view(number))
    query = " ".join(search)
    if query:
        answers.append(gh_list("--search", query, f"search: {query}"))
    return answers


def body(argv) -> int:
    selectors = argv[1:]
    if selectors[:1] in (["-h"], ["--help"]):
        sys.stdout.write(__doc__)
        return 0
    # An explicit empty first argument counts as none at all, the way the
    # shell's `case "${1:-}" in "")` arm read it: a variable that expanded to
    # nothing is a caller that meant to pass a selector and did not.
    if not selectors or not selectors[0]:
        sys.stderr.write(f"{PROG}: at least one selector is required\n\n")
        sys.stderr.write(__doc__)
        return 2
    merged = iss.merge(resolve(selectors))
    # Printed before the empty case is judged: a caller reading stdout gets a
    # parseable `[]` whichever status it then sees.
    sys.stdout.write(cli.dumps(merged))
    if not merged:
        die("no issues matched: {}".format(" ".join(selectors)), 3)
    return 0


def main(argv) -> int:
    return cli.run(PROG, lambda: body(argv), (cli.Failure, iss.Invalid))


if __name__ == "__main__":
    sys.exit(main(sys.argv))
