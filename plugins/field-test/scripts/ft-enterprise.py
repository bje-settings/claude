#!/usr/bin/env python3
"""ft-enterprise.py: are the plugin under test and the repository it was tested
on in the same GitHub enterprise?

  ft-enterprise.py <plugin-repo-dir> <target-repo-dir>

Prints one JSON object:
  {inside, enterprise, plugin_owner, target_owner, reason}
Exit 2 on usage. Otherwise always 0, with an answer, because "we could not tell"
is an answer: it is `inside: false`, and the reason says why. Names are redacted
whenever this says false, so failing closed costs detail in an issue and never
leaks a repository name.

`inside` is true only when both owners appear under one enterprise slug in
  viewer { enterprises { nodes { slug organizations { nodes { login } } } } }
asked once per run through `gh api graphql`, with the organizations paginated.
Nothing is cached: a run is rare, the answer decides what gets published, and a
stale cache would decide it wrongly.

Overridable for tests: FT_GH (the gh command, default `gh`).

Stdlib only, Python 3.9: an end user runs this with the python3 macOS ships.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from lib import cli, enterprise, gitinfo  # noqa: E402  (needs HERE on sys.path first)

PROG = "ft-enterprise.py"
REASON_CHARS = 200


def gh(*args):
    """(ok, output) from the gh command, with stderr folded in.

    Folded in because the reason a query failed is what the answer carries: a
    token without read:enterprise and a machine with no network both come back
    as "outside", and only gh's own words tell them apart.
    """
    command = os.environ.get("FT_GH") or "gh"
    try:
        finished = subprocess.run(
            [command, *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
    except OSError as error:
        return False, str(error)
    return finished.returncode == 0, finished.stdout.decode("utf-8", "replace")


def answer(inside: bool, ent: str, reason: str, plugin_owner: str, target_owner: str) -> int:
    document = {
        "inside": inside,
        "enterprise": ent or None,
        "plugin_owner": plugin_owner or None,
        "target_owner": target_owner or None,
        "reason": reason,
    }
    sys.stdout.write(json.dumps(document, separators=(",", ":"), ensure_ascii=False) + "\n")
    return 0


def logins_for(slug: str, first, more: bool, cursor: str):
    """Every organization login in one enterprise, following the pages there are."""
    logins = enterprise.logins_of(first, slug)
    while more and cursor:
        ok, output = gh(
            "api",
            "graphql",
            "-f",
            f"query={enterprise.NEXT_PAGE}",
            "-f",
            f"slug={slug}",
            "-f",
            f"after={cursor}",
        )
        if not ok:
            break
        try:
            page = json.loads(output)
        except ValueError:
            break
        more_logins, more, cursor = enterprise.page_of(page)
        logins.extend(more_logins)
    return logins


def run(argv):
    if len(argv) > 1 and argv[1] in ("-h", "--help"):
        sys.stdout.write(__doc__)
        return 0
    if len(argv) != 3:
        sys.stderr.write(f"{PROG}: expected <plugin-repo-dir> <target-repo-dir>\n")
        return 2

    plugin_owner = gitinfo.owner_of(argv[1])
    target_owner = gitinfo.owner_of(argv[2])
    if not plugin_owner:
        return answer(
            False,
            "",
            f"no github origin remote in the plugin checkout ({argv[1]})",
            plugin_owner,
            target_owner,
        )
    if not target_owner:
        return answer(
            False,
            "",
            f"no github origin remote in the repository under test ({argv[2]})",
            plugin_owner,
            target_owner,
        )

    ok, output = gh("api", "graphql", "-f", f"query={enterprise.FIRST_PAGE}")
    if not ok:
        excerpt = " ".join(output.rstrip("\n").split("\n"))[:REASON_CHARS]
        return answer(
            False,
            "",
            f"could not read the enterprise list ({excerpt}); treating the run as outside",
            plugin_owner,
            target_owner,
        )
    try:
        first = json.loads(output)
    except ValueError:
        first = None
    if enterprise.enterprise_nodes(first) is None:
        return answer(
            False,
            "",
            "the enterprise query returned no data; the token may lack read:enterprise",
            plugin_owner,
            target_owner,
        )

    for slug, more, cursor in enterprise.enterprise_rows(first):
        if not slug:
            continue
        logins = logins_for(slug, first, more, cursor)
        if plugin_owner in logins and target_owner in logins:
            return answer(
                True,
                slug,
                f"{plugin_owner} and {target_owner} are both organizations "
                f"in the {slug} enterprise",
                plugin_owner,
                target_owner,
            )
    return answer(
        False,
        "",
        f"{plugin_owner} and {target_owner} are not both organizations "
        "in one enterprise you belong to",
        plugin_owner,
        target_owner,
    )


def main(argv):
    cli.reconfigure_streams()
    try:
        status = run(argv)
        # Forced now, while a closed pipe still lands in the arm below rather than
        # in the interpreter's own shutdown flush, which prints its own trace.
        sys.stdout.flush()
    except BrokenPipeError:
        cli.silence_broken_pipe()
        return 0
    except Exception as error:
        # The one status this script never returns on its own. The docstring
        # promises an answer or a usage error, so an arm nobody anticipated says
        # so in one line rather than printing a traceback and calling it an answer.
        sys.stderr.write(f"{PROG}: internal error: {type(error).__name__}: {error}\n")
        return 1
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv))
