#!/usr/bin/env python3
"""gh-shepherd-pr.py — the deterministic per-pull-request steps of /gh:shepherd.

Usage:
  gh-shepherd-pr.py <path> <number> state
  gh-shepherd-pr.py <path> <number> rebase
  gh-shepherd-pr.py <path> <number> recreate
  gh-shepherd-pr.py <path> <number> wait
  gh-shepherd-pr.py <path> <number> skip <reason-file>
  gh-shepherd-pr.py <path> <number> merged

Every action prints one JSON object: {"action", "ok", "detail", ...}. The
agent running the loop decides which action comes next; this script only
does the step, and refuses steps whose preconditions do not hold, so a
confused caller cannot make it act on the wrong pull request.

  state     the pull request as `summary` shapes it (see lib/shepherd.py)
  rebase    gh pr update-branch --rebase. Refuses unless the pull request is
            open. Reports the head SHA before and after.
  recreate  comments `@dependabot recreate`, then polls until the head SHA
            changes (`recreated`). If the pull request leaves OPEN with the
            head unmoved, returns `result: closed` or `merged` at once; a
            closed one was usually superseded by another pull request.
            Refuses on a pull request Dependabot did not author.
  wait      gh pr checks --watch --fail-fast, bounded (see below). Result is
            one of passed, failed, pending, merged; `failing` lists the
            failed checks and `log_tail` carries the failed steps' log, with
            `log_error` beside it when gh would not hand the log over. A
            watcher that failed for a reason of its own (a 502, an expired
            token) is `ok: false`, never `pending`.
  skip      posts the comment in <reason-file> and reports its URL. Refuses
            an empty file: a skip without a reason is not a skip.
  merged    whether the pull request is MERGED, and its merge commit.

The script never merges, never enables or disables auto-merge, never edits a
label, and never bypasses a check. The only writes are the rebase, the two
comments, and nothing else.

Environment:
  SHEPHERD_CI_SECONDS    typical CI wall time, from gh-shepherd-status.py
                         (default 300). The wait bound is twice this, clamped
                         to [120, 540] so it fits inside a ten-minute tool
                         call; the caller re-invokes `wait` on `pending`.
  SHEPHERD_POLL_SECONDS  interval for the recreate head-SHA poll (default: a
                         quarter of SHEPHERD_CI_SECONDS, no lower than 15; an
                         explicit value is honoured down to 1).
  SHEPHERD_LOG_LINES     lines of failed-step log to keep (default 60).
  SHEPHERD_WAIT_BOUND    override the computed wait bound, in seconds. For
                         tests and for repos whose CI is far from typical.

Exits 0 when the action ran and reported (including ok:false refusals), 2 on
a usage error, 1 when gh could not answer at all, and 3 on an internal error,
which is outside the documented set so a caller cannot mistake it for an answer.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

SHEPHERD_LIB = os.path.join(HERE, "lib", "shepherd.py")

try:
    from lib import shepherd, streams  # noqa: E402
except ImportError:
    # A checkout missing its own library is reported as the wiring mistake it
    # is, rather than as a traceback naming an import the reader did not write.
    shepherd = None
    streams = None

ACTIONS = ("state", "rebase", "recreate", "wait", "skip", "merged")

NUMBER_RE = re.compile(r"^[1-9][0-9]*$")
DIGITS_RE = re.compile(r"^[0-9]+$")
POSITIVE_RE = re.compile(r"^[1-9][0-9]*$")

# The link shape an Actions job reports under, and the only one whose log can
# be fetched: .../actions/runs/<run>/job/<job>.
JOB_LINK_RE = re.compile(r"/actions/runs/([0-9]+)/job/([0-9]+)")

# Colour the log viewer would render. In a JSON string it is noise, and the
# agent reading the tail cannot see it anyway.
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

URL_RE = re.compile(r"https://[^ \n]+")

DEFAULT_CI_SECONDS = 300
DEFAULT_LOG_LINES = 60

# The bound on a single `wait`, so it fits inside a ten-minute tool call. The
# caller re-invokes `wait` when it returns `pending`.
WAIT_BOUND_MIN = 120
WAIT_BOUND_MAX = 540

# The floor on the recreate poll interval when it was derived rather than given.
POLL_FLOOR = 15

# The exit codes `gh pr checks` uses to say something about the checks: 0 all
# passed, 1 one failed, 8 still pending. 124 is this script's own bound. Any
# other code is gh failing to answer at all -- a 502, a rate limit, an expired
# token -- and reporting that as `pending` would have the caller wait it out one
# CI cycle at a time forever.
WATCHER_CODES = (0, 1, 8, 124)

# How much of a failed watcher's stderr travels in the detail. Enough for the
# HTTP status and the message under it, not the whole of gh's help text.
WATCHER_ERR_LINES = 5


def use_utf8(stream):
    if streams is not None:
        streams.use_utf8(stream)


def one_line(text):
    """gh's output on one line, so it can sit in a JSON detail.

    Bytes or text; the whitespace is collapsed rather than only the newlines
    replaced, so a message does not arrive with a trailing space where gh's own
    final newline was.
    """
    if not text:
        return ""
    if isinstance(text, bytes):
        text = text.decode("utf-8", "replace")
    return " ".join(text.split())


def ignored(name, raw, default):
    """Say once that an override was not used, and hand back the default.

    A value someone set to change the run and that changed nothing is worth a
    line: stderr, so the JSON on stdout that the caller parses is untouched.
    """
    print(f"{name}={raw} ignored; using {default}", file=sys.stderr)
    return default


def env_int(name, default, pattern=DIGITS_RE):
    """An integer from the environment, or the default for anything else.

    A stray value must not be the thing that decides a run, which is why an
    unparseable one falls back rather than failing: the shell version validated
    with these same patterns for the same reason. Unlike the shell version it
    says so, because a silent fallback is how a bound nobody meant to use gets
    used for a whole run.
    """
    raw = os.environ.get(name, "")
    if raw == "":
        return default
    if not pattern.match(raw):
        return ignored(name, raw, default)
    return int(raw)


def clamp(value, low, high):
    return max(low, min(value, high))


def kill_group(child):
    """Stop the watcher and anything it started.

    `gh pr checks --watch` polls the API in a loop; killing the child alone can
    leave a helper behind. The child is its own session leader, so the group
    signalled here cannot reach this script or the session that started it.
    """
    try:
        os.killpg(os.getpgid(child.pid), signal.SIGKILL)
    except OSError:
        # Already gone, or with no group of its own to signal.
        child.kill()


def run_bounded(bound, args):
    """(exit code, the tail of stderr, seconds spent) for a command with a deadline.

    124 says the bound was hit, mirroring coreutils `timeout`, which is what the
    shell version's hand-built background timer reported. Stdout is discarded:
    the pull request is re-read afterwards and that is the source of truth, not
    the watcher's screen. Stderr is not, because it is the only place a watcher
    that could not reach GitHub says so, and without it a 502 is
    indistinguishable from checks that are still running.

    The elapsed time is measured rather than assumed: a watcher that returned
    early did not wait the bound, and saying it did misleads a caller deciding
    whether to wait again.

    Popen rather than `subprocess.run(timeout=...)`: on a timeout the whole
    process group has to go, and `TimeoutExpired` does not carry the pid to
    signal it by.
    """
    started = time.monotonic()

    def spent():
        return int(time.monotonic() - started)

    try:
        child = subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except OSError as error:
        # gh was on PATH at the preflight and cannot be executed now: a partial
        # install, or a machine out of processes. 127 is the shell's own "could
        # not execute", and it is outside WATCHER_CODES, so the caller reports
        # it rather than reading the rollup as if a watcher had run.
        return 127, f"cannot run gh: {error}", spent()
    try:
        _, err = child.communicate(timeout=bound)
        code = child.returncode
    except subprocess.TimeoutExpired:
        kill_group(child)
        _, err = child.communicate()
        code = 124
    text = (err or b"").decode("utf-8", "replace")
    return code, one_line(tail_lines(text, WATCHER_ERR_LINES)), spent()


def poll_interval(ci_seconds):
    """Seconds between two recreate polls.

    An interval nobody gave is derived from the CI cycle and floored, so a fast
    repository is not polled every second. One that was given is honoured below
    that floor, which is what the tests set; one that is not a number at all
    falls back to the floor rather than failing the run.

    A zero interval would spin without ever reaching the bound, which is the one
    way this loop could fail to terminate. The shell version had that hole;
    nothing asks for it, so it is floored at a second rather than kept.
    """
    raw = os.environ.get("SHEPHERD_POLL_SECONDS", "")
    if raw == "":
        interval = max(ci_seconds // 4, POLL_FLOOR)
    elif DIGITS_RE.match(raw):
        interval = int(raw)
    else:
        interval = ignored("SHEPHERD_POLL_SECONDS", raw, POLL_FLOOR)
    return max(interval, 1)


def tail_lines(text, count):
    """The last `count` lines, joined by newlines, as `tail -n` into `$(...)` gave.

    Command substitution stripped the trailing newline, so the result never ends
    in one and an empty log is the empty string rather than "\\n".
    """
    lines = text.splitlines()
    return "\n".join(lines[-count:] if count < len(lines) else lines)


class Shepherd:
    """One action against one pull request."""

    def __init__(self, repo, number, action, ci_seconds, log_lines):
        self.repo = repo
        self.number = number
        self.action = action
        self.ci_seconds = ci_seconds
        self.log_lines = log_lines
        # Set once the reader closes the pipe. Nothing here prints before its
        # work is done, but a broken pipe must never abandon a rebase or a
        # comment that has already been made half-way through reporting it.
        self.quiet = False
        # gh's stderr from the last read, so a caller that polls can say why a
        # read failed instead of reporting the silence as a fact about the
        # pull request.
        self.read_err = ""

    # -------------------------------------------------------------- output ---

    def emit(self, ok, detail, **extra):
        """Print the one JSON object this action reports.

        A reader that has gone away stops the output only: by the time this is
        reached the rebase or the comment has already happened, and a run
        abandoned here would exit 0 with nothing saying what it did.
        """
        document = {
            "action": self.action,
            "repo": self.repo,
            "number": self.number,
            "ok": ok,
            "detail": detail,
        }
        document.update(extra)
        if self.quiet:
            return
        try:
            print(json.dumps(document, indent=2, ensure_ascii=False))
        except BrokenPipeError:
            self.quiet = True
            if streams is not None:  # pragma: no branch - a broken checkout has none
                streams.silence_output()

    # ---------------------------------------------------------------- gh ---

    def read_pr(self):
        """The pull request as `summary` shapes it, or None if gh cannot answer.

        `read_err` is left saying why, so a caller reports the reason rather
        than the silence. An answer missing a field the loop decides from is one
        of those reasons: `summary` shapes whatever it is given, and an empty
        object comes back out of it as a pull request whose checks are `none`,
        which `wait` reads as passed.
        """
        try:
            completed = subprocess.run(
                [
                    "gh",
                    "pr",
                    "view",
                    str(self.number),
                    "--repo",
                    self.repo,
                    "--json",
                    shepherd.PR_FIELDS,
                ],
                capture_output=True,
            )
        except OSError as error:
            self.read_err = f"cannot run gh: {error}"
            return None
        self.read_err = one_line(completed.stderr)
        if completed.returncode != 0:
            if not self.read_err:
                self.read_err = f"gh exited {completed.returncode}"
            return None
        try:
            pull = json.loads(completed.stdout.decode("utf-8", "replace") or "null")
        except ValueError:
            self.read_err = "gh answered with something that is not JSON"
            return None
        missing = shepherd.missing_field(pull)
        if missing:
            self.read_err = f"gh answered without {missing}"
            return None
        return shepherd.summary(pull)

    def last_read_error(self):
        """Why the last read did not answer. No quote escaping: json.dumps encodes it."""
        return self.read_err

    def gh_text(self, args):
        """(succeeded, gh's combined output on one line) for a mutating call."""
        try:
            completed = subprocess.run(
                ["gh", *args],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )
        except OSError as error:
            return False, f"cannot run gh: {error}"
        return completed.returncode == 0, one_line(completed.stdout)

    def unreadable(self):
        """Refuse, saying what gh said, rather than reporting the silence.

        A caller that polls -- and a human reading the transcript afterwards --
        cannot tell a deleted pull request from an expired token without this.
        """
        return self.emit(
            False,
            "could not read pull request #{}: {}".format(
                self.number, self.last_read_error() or "gh returned no JSON object"
            ),
        )

    def refuse_not_open(self, pull):
        return self.emit(
            False,
            "refused: pull request is {}, not OPEN".format(pull.get("state")),
            pr=pull,
        )

    # ------------------------------------------------------------ actions ---

    def state(self):
        pull = self.read_pr()
        if pull is None:
            return self.unreadable()
        return self.emit(True, "read", pr=pull)

    def rebase(self):
        pull = self.read_pr()
        if pull is None:
            return self.unreadable()
        if pull.get("state") != "OPEN":
            return self.refuse_not_open(pull)
        before = pull.get("headRefOid")
        ok, out = self.gh_text(
            ["pr", "update-branch", str(self.number), "--repo", self.repo, "--rebase"]
        )
        if not ok:
            return self.emit(False, f"rebase failed: {out}", before=before)
        pull = self.read_pr()
        if pull is None:
            # The branch update happened; only the confirmation did not. Told
            # `ok: false` the caller would decide again and rebase a second
            # time, which costs another CI run for a read that failed.
            return self.emit(
                True,
                "update-branch succeeded but the pull request could not be re-read: "
                + (self.last_read_error() or "gh returned no JSON object"),
                before=before,
                after="",
                pr=None,
                output=out,
            )
        after = pull.get("headRefOid") or ""
        if after == before:
            # `gh pr update-branch` is asynchronous: it returns as soon as
            # GitHub accepts the request, and prints the same success line when
            # the branch was already current. Either way the head has not moved,
            # and calling that "rebased" tells the caller a new CI run is coming
            # when none may be.
            detail = (
                "update-branch reported success and the head has not moved: the update is "
                "still queued, or the branch was already up to date"
            )
        else:
            detail = "rebased"
        return self.emit(True, detail, before=before, after=after, pr=pull, output=out)

    def recreate(self):
        pull = self.read_pr()
        if pull is None:
            return self.unreadable()
        if not pull.get("is_dependabot"):
            # Deliberately not `is_bot`: renovate and github-actions are bots
            # too, and `@dependabot recreate` on one of their pull requests is
            # a comment nothing will ever answer.
            return self.emit(
                False,
                f"refused: #{self.number} was not authored by Dependabot; recreate only works "
                "for its own pull requests",
                pr=pull,
            )
        if pull.get("state") != "OPEN":
            return self.refuse_not_open(pull)
        before = pull.get("headRefOid")
        ok, out = self.gh_text(
            [
                "pr",
                "comment",
                str(self.number),
                "--repo",
                self.repo,
                "--body",
                "@dependabot recreate",
            ]
        )
        if not ok:
            return self.emit(False, f"could not post the recreate comment: {out}")

        # Dependabot answers asynchronously and leaves no signal but a new head
        # SHA. Poll a few times per typical CI cycle, bounded by two cycles --
        # but never by less than one interval, or a small SHEPHERD_CI_SECONDS
        # would post the comment and then report a read that never happened.
        interval = poll_interval(self.ci_seconds)
        bound = max(self.ci_seconds * 2, interval)
        waited = 0
        reads_ok = 0
        reads_failed = 0
        after = ""
        while waited < bound:
            time.sleep(interval)
            waited += interval
            pull = self.read_pr()
            # A poll that cannot read the pull request says nothing about it.
            # Count it and keep going; it is reported below if no read ever
            # succeeded.
            if pull is None:
                reads_failed += 1
                continue
            reads_ok += 1
            after = pull.get("headRefOid") or ""
            state = pull.get("state") or ""
            # A moved head is the answer this action exists for, so it wins over
            # any state change seen in the same poll: a recreated branch that
            # already went green and auto-merged is a success, not a supersession.
            if after and after != before:
                return self.emit(True, "recreated", before=before, after=after, pr=pull)
            # The head never moved but the pull request is no longer open.
            # Dependabot closes a pull request instead of recreating it when
            # another one already shipped the same or a newer bump; a human can
            # close or merge it too. The script reports what it saw and leaves
            # the attribution to the caller.
            if state == "OPEN":
                continue
            if state == "MERGED":
                return self.emit(
                    True,
                    "pull request merged while waiting for recreate; the head did not move",
                    result="merged",
                    before=before,
                    after=after,
                    pr=pull,
                )
            if state == "CLOSED":
                return self.emit(
                    True,
                    "pull request closed while waiting for recreate; superseded by "
                    "another pull request is the usual cause",
                    result="closed",
                    before=before,
                    after=after,
                    pr=pull,
                )
            return self.emit(
                False,
                f"unexpected pull request state after recreate: '{state}'",
                before=before,
                pr=pull,
            )
        if reads_ok == 0:
            return self.emit(
                False,
                "recreate requested but the pull request could not be re-read in "
                f"{bound}s ({reads_failed} attempts): {self.last_read_error()}",
                before=before,
                read_failures=reads_failed,
            )
        return self.emit(
            False,
            f"recreate requested but the head did not change within {bound}s",
            before=before,
            read_failures=reads_failed,
            pr=pull,
        )

    def wait(self):
        pull = self.read_pr()
        if pull is None:
            return self.unreadable()
        if pull.get("state") == "MERGED":
            return self.emit(True, "merged", result="merged", pr=pull)
        if pull["checks"]["state"] == "none":
            return self.emit(True, "no checks reported on this head", result="passed", pr=pull)

        # Only watch while something is still running. A rollup that is already
        # terminal is answered from the pull request itself: `gh pr checks
        # --watch` has been seen to keep watching a fully finished rollup that
        # contains skipped checks, and a watcher that cannot return is worse
        # than no watcher.
        bound = env_int(
            "SHEPHERD_WAIT_BOUND",
            clamp(self.ci_seconds * 2, WAIT_BOUND_MIN, WAIT_BOUND_MAX),
            POSITIVE_RE,
        )
        watcher_rc, watcher_err, waited = 0, "", 0
        if pull["checks"]["state"] == "pending":
            watcher_rc, watcher_err, waited = run_bounded(
                bound,
                [
                    "gh",
                    "pr",
                    "checks",
                    str(self.number),
                    "--repo",
                    self.repo,
                    "--watch",
                    "--fail-fast",
                ],
            )
            if watcher_rc not in WATCHER_CODES:
                # gh said nothing about the checks: it could not reach GitHub,
                # or could not start at all. Reported as `pending` this would
                # have the caller wait out a broken token one CI cycle at a
                # time, so it is a refusal carrying what gh printed.
                return self.emit(
                    False,
                    f"watcher failed after {waited}s: {watcher_err or f'gh exited {watcher_rc}'}",
                    bound=bound,
                    watcher_rc=watcher_rc,
                    pr=pull,
                    waited=waited,
                )
        # gh pr checks exit codes: 0 all passed, 1 a check failed, 8 still
        # pending. 124 is our bound. Re-read the pull request afterwards in
        # every case, since a passing rollup may already have let auto-merge
        # fire, and decide from the rollup rather than the watcher's exit code.
        pull = self.read_pr()
        if pull is None:
            return self.emit(
                False,
                "checks finished but the pull request could not be re-read: "
                + (self.last_read_error() or "gh returned no JSON object"),
            )
        if pull.get("state") == "MERGED":
            return self.emit(True, "merged", result="merged", pr=pull)
        checks_state = pull["checks"]["state"]
        if checks_state in ("passed", "none"):
            return self.emit(True, "checks passed", result="passed", pr=pull)
        if checks_state == "pending":
            # The time actually spent, not the bound: a watcher that returned
            # early did not wait it, and a caller sizing its next call reads
            # this number.
            return self.emit(
                True,
                f"checks still running after {waited}s",
                result="pending",
                bound=bound,
                watcher_rc=watcher_rc,
                pr=pull,
                waited=waited,
            )

        # Something failed. Name the checks and pull the failed steps' log for
        # the first Actions job among them, so the agent can classify without
        # another round trip.
        log_tail, log_error = self.failed_log(pull["checks"]["failing"])
        extra = {"log_tail": log_tail}
        if log_error:
            # Only when there is one: "no log" and "gh would not hand the log
            # over" call for different next steps, and a field that is always
            # there and almost always empty stops being read.
            extra["log_error"] = log_error
        return self.emit(True, "checks failed", result="failed", pr=pull, **extra)

    def failed_log(self, failing):
        """(the failed steps' log for the first Actions job among `failing`, why not).

        Both empty when nothing failing was an Actions job, which is a fact
        about the checks rather than a problem. A log gh would not hand over is
        the other case, and it says so: the agent classifies a failure from this
        text, so an empty tail it cannot tell apart from "the job printed
        nothing" is the difference between a skip and a fix.
        """
        for check in failing:
            match = JOB_LINK_RE.search(check.get("link") or "")
            if not match:
                continue
            try:
                completed = subprocess.run(
                    [
                        "gh",
                        "run",
                        "view",
                        match.group(1),
                        "--repo",
                        self.repo,
                        "--job",
                        match.group(2),
                        "--log-failed",
                    ],
                    capture_output=True,
                )
            except OSError as error:
                return "", f"cannot run gh: {error}"
            if completed.returncode != 0:
                return "", "could not read the failed job's log: " + (
                    one_line(completed.stderr) or f"gh exited {completed.returncode}"
                )
            text = ANSI_RE.sub("", completed.stdout.decode("utf-8", "replace"))
            return tail_lines(text, self.log_lines), ""
        return "", ""

    def skip(self, reason_file):
        if not os.path.isfile(reason_file) or os.path.getsize(reason_file) == 0:
            return self.emit(False, f"refused: reason file is missing or empty: {reason_file}")
        pull = self.read_pr()
        if pull is None:
            return self.unreadable()
        if pull.get("state") != "OPEN":
            return self.refuse_not_open(pull)
        ok, out = self.gh_text(
            ["pr", "comment", str(self.number), "--repo", self.repo, "--body-file", reason_file]
        )
        if not ok:
            return self.emit(False, f"could not post the skip comment: {out}")
        urls = URL_RE.findall(out)
        return self.emit(True, "skip comment posted", comment_url=urls[-1] if urls else "")

    def merged(self):
        pull = self.read_pr()
        if pull is None:
            return self.unreadable()
        if pull.get("state") == "MERGED":
            return self.emit(True, "merged", merged=True, mergeCommit=pull.get("mergeCommit"))
        else:
            return self.emit(True, "not merged: {}".format(pull.get("state")), merged=False)


def usage(stream=sys.stdout):
    print(__doc__.strip(), file=stream)


def resolve_repo():
    """(nameWithOwner, why not), the second empty when the first resolved.

    Parsed here rather than with `gh --jq`, so nothing in this script needs jq
    on PATH any more. gh's own words travel with the failure: a caller cannot
    tell an expired token from a directory that is not a GitHub repository
    without them.
    """
    try:
        completed = subprocess.run(
            ["gh", "repo", "view", "--json", "nameWithOwner"],
            capture_output=True,
        )
    except OSError as error:
        return None, f"cannot run gh: {error}"
    problem = one_line(completed.stderr)
    if completed.returncode != 0:
        return None, problem or f"gh exited {completed.returncode}"
    try:
        view = json.loads(completed.stdout.decode("utf-8", "replace") or "null")
    except ValueError:
        return None, problem or "gh answered with something that is not JSON"
    if not isinstance(view, dict):
        return None, "gh answered with no repository object"
    name = view.get("nameWithOwner") or None
    if not name:
        return None, "gh answered without nameWithOwner"
    return name, ""


def run(argv):
    if streams is not None:
        streams.bind_closed_streams()
    use_utf8(sys.stdout)
    use_utf8(sys.stderr)

    # Before the usage text, as the shell version checked it: a copy of this
    # script sitting on its own answers the same way whatever it is asked.
    if shepherd is None or not os.path.exists(SHEPHERD_LIB):
        print(f"missing {SHEPHERD_LIB}", file=sys.stderr)
        return 2
    if argv and argv[0] in ("-h", "--help"):
        usage()
        return 0
    if len(argv) < 3:
        usage(sys.stderr)
        return 2

    target, number, action = argv[0], argv[1], argv[2]
    rest = argv[3:]

    if not os.path.isdir(target):
        print(f"not a directory: {target}", file=sys.stderr)
        return 2
    if not NUMBER_RE.match(number):
        print(f"not a pull request number: {number}", file=sys.stderr)
        return 2
    try:
        os.chdir(target)
    except OSError as error:
        # Named, because "exit 2" against a path the caller believes in reads as
        # a bug in the caller rather than as a directory it may not enter.
        print(f"cannot enter {target}: {error}", file=sys.stderr)
        return 2
    if (
        subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode
        != 0
    ):
        print(f"not a git repository: {target}", file=sys.stderr)
        return 2
    if shutil.which("gh") is None:
        print("gh is required", file=sys.stderr)
        return 1

    repo, problem = resolve_repo()
    if repo is None:
        print(f"could not resolve the repository with gh: {problem}", file=sys.stderr)
        return 1

    ci_seconds = env_int("SHEPHERD_CI_SECONDS", DEFAULT_CI_SECONDS)
    log_lines = env_int("SHEPHERD_LOG_LINES", DEFAULT_LOG_LINES, POSITIVE_RE)

    if action not in ACTIONS:
        print(f"unknown action: {action}", file=sys.stderr)
        usage(sys.stderr)
        return 2
    if action == "skip" and not (rest and rest[0]):
        # An empty argument is the same usage error as no argument, which is
        # what the shell version's `[ -z "$4" ]` said: `skip ""` is a caller
        # that lost its variable, not a skip whose reason file is missing.
        print("skip needs a reason file", file=sys.stderr)
        return 2

    worker = Shepherd(repo, int(number), action, ci_seconds, log_lines)
    if action == "skip":
        worker.skip(rest[0])
    else:
        getattr(worker, action)()

    try:
        # Forces the write now, while BrokenPipeError still lands here. Left
        # implicit, buffered output is flushed during interpreter shutdown
        # instead, which prints its own "Exception ignored in" trace. Only the
        # flush is wrapped: the action has already finished by this point.
        sys.stdout.flush()
    except BrokenPipeError:
        if streams is not None:  # pragma: no branch - a broken checkout has none
            streams.silence_output()
    return 0


def main(argv):
    """`run`, with anything it did not expect reported rather than raised.

    Exit 3 is outside the documented set on purpose: a caller parsing the JSON
    on stdout must not read a crash as an answer, and the agent gets a line
    naming what broke instead of a traceback it cannot act on. A null element in
    a `statusCheckRollup` used to arrive here as an exit-1 AttributeError.
    """
    try:
        return run(argv)
    except Exception as error:
        print(
            f"{os.path.basename(__file__)}: internal error: {type(error).__name__}: {error}",
            file=sys.stderr,
        )
        return 3


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
