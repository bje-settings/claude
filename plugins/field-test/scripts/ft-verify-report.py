#!/usr/bin/env python3
"""ft-verify-report.py: check a field-test report against GitHub, pull request by
pull request.

  ft-verify-report.py <report.json> [--repo <owner/name>]

report.json is what the target skill claimed:
  {"repo": "owner/name", "prs": [{"number": 11, "claimed": "merged"}, ...]}
`claimed` is one of merged, closed, open, skipped. --repo overrides the repo in
the file.

Prints {ok, checked, matched, mismatches, results} and exits:
  0  every claim holds
  1  at least one claim does not; each mismatch is a finding the loop takes
     back through ft-issue.py like any other
  2  usage, or a report this cannot read (no prs array, a number written as
     a word, no repository)
  3  the report names no pull requests: nothing to check is not a pass
  4  gh could not answer, so no claim was checked; also an internal error,
     which is not a verdict about the report

The comparison is in lib/verify.py. Nothing here trusts the report: a pull
request gh cannot answer for is a mismatch, not a pass. A gh that answered for
none of them is the exit-4 arm instead, since nothing was checked. Pull request numbers
written as strings ("50") are read as numbers, since the report is assembled
from a markdown table.

Overridable for tests: FT_GH (the gh command, default `gh`).
"""

# Stdlib only, Python 3.9: an end user runs this with the python3 macOS ships.

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from lib import cli, verify  # noqa: E402  (needs HERE on sys.path first)

PROG = "ft-verify-report.py"

DIGITS = re.compile(r"^[0-9]+$")
EXCERPT = 160

# An arm nobody anticipated is not a verdict about the report. Exit 1 here means
# the report and GitHub disagree, and the harden skill files every mismatch as an
# issue against the target; a bug in this script would file findings nobody can
# act on. 4 is the status the skill retries once and then pauses on.
INTERNAL_ERROR = 4


class Failure(Exception):
    def __init__(self, message: str, status: int = 1) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def die(message: str, status: int = 1):
    raise Failure(message, status)


def excerpt(text: str) -> str:
    """A tool's own words on one line, short enough to sit in a message."""
    return " ".join(text.rstrip("\n").split("\n"))[:EXCERPT]


def parse_arguments(argv):
    """(report path, repo override) or the usage refusal."""
    report = argv[0]
    repo = ""
    index = 1
    while index < len(argv):
        argument = argv[index]
        if argument != "--repo":
            die(f"unknown argument: {argument}", 2)
        value = argv[index + 1] if index + 1 < len(argv) else ""
        if not value or value.startswith("-"):
            die("--repo needs a value", 2)
        repo = value
        index += 2
    return report, repo


def read_report(path: str):
    if not os.path.isfile(path):
        die(f"no report at {path}", 2)
    try:
        with open(path, encoding="utf-8") as handle:
            document = json.load(handle)
    except OSError as error:
        # Not "no report at": the file is there, and a permission or a device is
        # a different fix from a report the skill never wrote.
        die(f"cannot read {path}: {error}", 2)
    except ValueError:
        die(f"report is not valid JSON: {path}", 2)
    if not isinstance(document, dict) or not isinstance(document.get("prs"), list):
        die(f"report has no prs array: {path}", 2)
    return document


def word(value) -> str:
    """A refused number the way jq printed it, so the message names what was there.

    Python's `str` renders JSON's null and true as None and True, which are not
    words any report contains and send the reader looking for the wrong thing. A
    string stays as it is: `got: fifty` is what the report holds.
    """
    if isinstance(value, str):
        return value
    return json.dumps(value)


def claims_of(document, path: str):
    """The report's claims, with numbers read as numbers.

    A number written as a string is read as one; anything else is refused rather
    than compared, because `50 == "50"` was false to jq and would have read as
    "gh gave no answer".
    """
    claims = []
    for entry in document["prs"]:
        if not isinstance(entry, dict):
            die(f"cannot read the claims out of {path}", 2)
        number = entry.get("number")
        if isinstance(number, str) and DIGITS.match(number):
            number = int(number)
        claims.append({"number": number, "claimed": entry.get("claimed") or ""})
    bad = [
        word(claim["number"])
        for claim in claims
        # bool before int on purpose: True is an int to Python and would be
        # accepted as a pull request number, which no report ever means.
        if isinstance(claim["number"], bool) or not isinstance(claim["number"], (int, float))
    ]
    if bad:
        die("pull request numbers must be numbers, got: " + ", ".join(bad), 2)
    return claims


def ask_gh(command: str, number, repo: str):
    """What gh says about one pull request, or a record saying it could not say.

    A failure is recorded rather than raised: a pull request gh cannot answer
    for is a mismatch the report has to own, not a reason to stop checking the
    rest -- as long as gh was answering at all, which `verify.answered` decides
    once every claim has been asked. An answer that is not a JSON object is the
    other case, and that one stops the run where it stands: nothing was checked,
    and reporting a mismatch for it would blame the report for gh.
    """
    try:
        finished = subprocess.run(
            [command, "pr", "view", str(number), "--repo", repo, "--json", "number,state,isDraft"],
            capture_output=True,
            check=False,
        )
    except OSError as error:
        return {"number": number, "error": excerpt(str(error))}
    output = finished.stdout.decode("utf-8", "replace")
    if finished.returncode != 0:
        return {"number": number, "error": excerpt(finished.stderr.decode("utf-8", "replace"))}
    try:
        answer = json.loads(output)
    except ValueError:
        answer = None
    if not isinstance(answer, dict):
        die(
            f"gh answered with something this cannot read for pull request {number}: "
            + excerpt(output),
            4,
        )
    return answer


NOTHING_TO_CHECK = (
    '{"ok": false, "checked": 0, "matched": 0, "mismatches": [], "results": [],\n'
    ' "reason": "nothing to check: the report names no pull requests"}\n'
)


def run(argv):
    first = argv[1] if len(argv) > 1 else ""
    if first in ("-h", "--help"):
        sys.stdout.write(__doc__)
        return 0
    if first == "":
        sys.stderr.write(__doc__)
        return 2

    path, repo_argument = parse_arguments(argv[1:])
    document = read_report(path)
    repo = repo_argument or str(document.get("repo") or "")
    if not repo:
        die("no repository: put one in the report or pass --repo", 2)

    claims = claims_of(document, path)
    if not claims:
        sys.stdout.write(NOTHING_TO_CHECK)
        return 3

    command = os.environ.get("FT_GH") or "gh"
    actual = [ask_gh(command, claim["number"], repo) for claim in claims]
    if not verify.answered(actual):
        # Nothing was checked, so there is nothing to report against the target.
        # Exit 1 here would file one issue per claim for a gh that never ran.
        die(
            "gh could not answer, so no claim was checked: "
            + excerpt(actual[0].get("error") or ""),
            4,
        )
    result = verify.compare(claims, actual)
    sys.stdout.write(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    # Exit 1 when anything did not match, so a caller can branch on the status
    # alone rather than parsing the object back.
    return 0 if result["ok"] else 1


def main(argv):
    cli.reconfigure_streams()
    try:
        status = run(argv)
        # Forced now, while a closed pipe still lands in the arm below rather
        # than in the interpreter's own shutdown flush, which prints its trace.
        sys.stdout.flush()
    except Failure as error:
        sys.stderr.write(f"{PROG}: {error.message}\n")
        return error.status
    except BrokenPipeError:
        cli.silence_broken_pipe()
        return 0
    except Exception as error:
        sys.stderr.write(f"{PROG}: internal error: {type(error).__name__}: {error}\n")
        return INTERNAL_ERROR
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv))
