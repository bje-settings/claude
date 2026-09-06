#!/usr/bin/env python3
"""gh-sync-repo.py — sync one checkout: move to the default branch, fast-forward,
install if a lock file changed, and prune branches whose work has landed.

Usage:
  gh-sync-repo.py [--dry-run] [--no-install] <repo-path>

Flags may also arrive as GH_SYNC_DRY_RUN=1 / GH_SYNC_NO_INSTALL=1, which is how
gh-sync.sh passes them to the per-repo jobs it backgrounds.

Exit status is 0 for a synced repo AND for a skipped one: skipping is a normal
outcome, not a failure. Non-zero means the script itself broke.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from lib import install as install_lib  # noqa: E402
from lib import prs as prs_lib  # noqa: E402

USAGE = "usage: gh-sync-repo.py [--dry-run] [--no-install] <repo-path>"

# The bulk lookup: one API call covers every branch in the repo. A window this
# size that comes back full is a window, not an answer, which is what
# read_merge_proof records as pr_bulk_saturated.
PR_LIMIT = 200

# The per-branch fallback, asked only for a branch the saturated bulk window
# could not settle. Smaller because it is scoped to one head ref, and saturated
# here means the same thing: too many merged pull requests share the name to
# conclude anything about this commit.
PR_BRANCH_LIMIT = 100

# The markers git leaves behind mid-operation. Checked for every worktree, not
# just this one: a rebase in a linked worktree leaves its HEAD detached, so that
# worktree contributes no branch mapping later and its branch would otherwise
# look free to delete.
IN_PROGRESS_MARKERS = (
    "rebase-merge",
    "rebase-apply",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
)


class Skip(Exception):
    """A repository this run refuses to touch, and the reason to report."""


def flag_is_set(name):
    """An env flag as gh-sync.sh sets it: "1" on, "0" or unset off."""
    return os.environ.get(name, "0") not in ("", "0")


def git(*args, **kwargs):
    """Run git, capturing stdout and discarding stderr, as the shell did.

    A git that is not on PATH is reported as a failed command rather than raised:
    every caller already handles "git said no", and the preflight turns the first
    such failure into the ordinary "not a git repository" skip. Letting the OSError
    out would replace that one-line skip with a traceback.
    """
    try:
        return subprocess.run(
            ["git", *args],
            cwd=kwargs.get("cwd"),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        return subprocess.CompletedProcess(["git", *args], 127, b"")


def git_out(*args, **kwargs):
    """git's stdout, stripped of its trailing newline, or None if it failed."""
    completed = git(*args, **kwargs)
    if completed.returncode != 0:
        return None
    return completed.stdout.decode("utf-8", "replace").rstrip("\n")


def git_ok(*args, **kwargs):
    return git(*args, **kwargs).returncode == 0


def git_lines(*args, **kwargs):
    """git's stdout as a list of non-empty lines, or None if it failed."""
    out = git_out(*args, **kwargs)
    if out is None:
        return None
    return [line for line in out.split("\n") if line]


def last_line(text):
    """The last line of a command's output, the way "${var##*$'\\n'}" read it."""
    return text.rstrip("\n").rsplit("\n", 1)[-1]


class SyncRepo:
    """One checkout's sync, from preflight to prune."""

    def __init__(self, repo, dry_run=False, no_install=False):
        self.repo = repo
        self.dry_run = dry_run
        self.no_install = no_install
        # Refined to the work tree name once the checkout root is resolved.
        self.name = os.path.basename(repo)
        self.header_printed = False
        self.top = None
        self.default = None
        self.tip = None
        # branch -> worktree path. Filled once the prune section is reached.
        self.worktrees = {}
        # Pull-request state, all of it "unknown" until the bulk lookup runs.
        self.pr_lookup_ok = False
        self.pr_rows = []
        self.pr_own = []
        self.pr_bulk_saturated = False
        self.pr_fallback_off = False
        self.pr_unchecked = 0

    # ------------------------------------------------------------- output ---

    def ok(self, text):
        self.ensure_header()
        print(f"  ✓ {text}")

    def bad(self, text):
        self.ensure_header()
        print(f"  ✗ {text}")

    def note(self, text):
        self.ensure_header()
        print(f"  · {text}")

    def ensure_header(self):
        if not self.header_printed:
            print(self.name)
            self.header_printed = True

    # ---------------------------------------------------------- preflight ---

    def check_in_progress(self, directory):
        """The name of the marker git left in `directory`, or "" for none."""
        gitdir = git_out("-C", directory, "rev-parse", "--git-dir")
        if gitdir is None:
            return ""
        if not os.path.isabs(gitdir):
            gitdir = os.path.join(directory, gitdir)
        for marker in IN_PROGRESS_MARKERS:
            if os.path.exists(os.path.join(gitdir, marker)):
                return marker
        return ""

    def preflight(self):
        """Refuse before anything is written, or resolve the checkout root."""
        try:
            os.chdir(self.repo)
        except OSError:
            raise Skip("cannot enter directory") from None

        top = git_out("rev-parse", "--show-toplevel")
        if not top:
            raise Skip("not a git repository")
        try:
            os.chdir(top)
        except OSError:
            raise Skip("cannot enter work tree") from None
        self.top = top
        self.name = os.path.basename(top)

        if not git_ok("remote", "get-url", "origin"):
            raise Skip("no 'origin' remote")

        marker = self.check_in_progress(top)
        if marker:
            raise Skip(f"git operation in progress ({marker})")

        # Untracked files deliberately do not block: checkout, fast-forward, and
        # branch deletion cannot touch them. Only tracked modifications and
        # staged changes do. A failed probe must not read as clean, so the exit
        # status is checked separately from the output: a corrupt or unreadable
        # index exits non-zero with empty stdout.
        dirty = git_out("status", "--porcelain", "--untracked-files=no")
        if dirty is None:
            raise Skip("cannot read the working tree state")
        if dirty:
            raise Skip("uncommitted changes")

    # ---------------------------------------------------- default branch ---

    def resolve_default_branch(self):
        ref = git_out("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
        if not ref and not self.dry_run:
            # Repairing origin/HEAD writes a ref, so it is skipped in --dry-run;
            # the fallbacks below answer the same question without touching the
            # repository.
            git("remote", "set-head", "origin", "--auto")
            ref = git_out("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
        if ref:
            return ref[len("refs/remotes/origin/") :]

        view = self.gh_json(["repo", "view", "--json", "defaultBranchRef"])
        if isinstance(view, dict):
            name = (view.get("defaultBranchRef") or {}).get("name")
            if name:
                return name

        for name in ("main", "master"):
            if git_ok("show-ref", "--verify", "--quiet", "refs/remotes/origin/" + name):
                return name
        return None

    # --------------------------------------------------------------- gh ---

    def gh_json(self, args):
        """Run gh and parse its JSON, or None if anything about that failed.

        A missing gh is one of those failures rather than a crash: the caller
        falls back to ancestry and says so.
        """
        if shutil.which("gh") is None:
            return None
        try:
            completed = subprocess.run(
                ["gh", *args],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
        except OSError:
            return None
        if completed.returncode != 0:
            return None
        try:
            return json.loads(completed.stdout.decode("utf-8", "replace") or "null")
        except ValueError:
            return None

    def pr_list(self, limit=PR_LIMIT, extra=()):
        args = [
            "pr",
            "list",
            "--state",
            "merged",
            "--base",
            self.default,
            "--limit",
            str(limit),
            *extra,
            "--json",
            prs_lib.FIELDS,
        ]
        rows = self.gh_json(args)
        if not isinstance(rows, list):
            return None
        # Every reader below calls .get on a row. A payload that is a list of
        # something else is not an answer about merged pull requests, so it takes
        # the same route a failed query does rather than crashing here or, worse,
        # being read as an empty window.
        if not all(isinstance(row, dict) for row in rows):
            return None
        return rows

    # ------------------------------------------------------------ advance ---

    def fetch(self):
        self.ensure_header()
        if not git_ok("fetch", "--prune", "origin"):
            self.bad("fetch failed; nothing changed")
            return False
        return True

    def advance(self):
        """Checkout and fast-forward. Returns (can_advance, target, advanced_from):

          can_advance    False when the default branch could not be checked out,
                         which is not fatal: the caller skips the install and
                         prunes anyway
          target         the short SHA of origin/<default>, the commit the branch
                         is being moved to
          advanced_from  the short SHA the branch actually moved off, or None when
                         it did not move (already up to date, diverged, a failed
                         merge, or a branch that does not exist yet). The caller
                         reads it as "is there a range to diff for a lock file".

        The default branch may be checked out in another worktree, in which case
        the checkout cannot succeed. That is not fatal: pruning still has value,
        so the caller carries on with can_advance false.
        """
        # An unborn HEAD, or a probe that could not run at all, has no branch name
        # to report. "HEAD" is what git itself echoes there and what the shell
        # version printed, and it keeps a None out of the "switched from ..." line.
        current = git_out("rev-parse", "--abbrev-ref", "HEAD") or "HEAD"
        can_advance = True

        if current != self.default:
            if self.dry_run:
                self.note(f"would switch from {current} to {self.default}")
            elif git_ok("checkout", self.default):
                self.ok(f"switched from {current} to {self.default}")
            else:
                self.bad(f"cannot switch to {self.default} (checked out elsewhere?); pruning only")
                can_advance = False

        if not can_advance:
            return False, None, None

        # self.tip is the same commit in full, already verified to exist, so it is
        # the honest fallback if the abbreviation itself cannot be read: a shorter
        # name for a commit is a convenience, and printing None instead would be a
        # lie in every line that quotes it.
        target = git_out("rev-parse", "--short", "origin/" + self.default) or self.tip
        if not git_ok("show-ref", "--verify", "--quiet", "refs/heads/" + self.default):
            # Only reachable in --dry-run, where the checkout above was not
            # performed.
            self.note(f"would create {self.default} from origin/{self.default} ({target})")
            return True, target, None

        # Always compare the default branch itself, never HEAD: in --dry-run we
        # have not switched, so HEAD is still whatever branch the user was
        # sitting on.
        # Same fallback as `target`: the branch was just verified to exist, so an
        # unreadable abbreviation still has a full SHA behind it, and this value is
        # both printed and used as the left end of the lock-file diff.
        before = git_out("rev-parse", "--short", self.default) or git_out("rev-parse", self.default)
        if before == target:
            self.note(f"{self.default} already up to date ({before})")
        elif not git_ok("merge-base", "--is-ancestor", self.default, "origin/" + self.default):
            self.bad(
                f"{self.default} has diverged from origin/{self.default}; needs a manual merge"
            )
        elif self.dry_run:
            self.note(f"would fast-forward {self.default} {before}..{target}")
            return True, target, before
        elif git_ok("merge", "--ff-only", "origin/" + self.default):
            self.ok(f"fast-forwarded {self.default} {before}..{target}")
            return True, target, before
        else:
            self.bad(f"could not fast-forward {self.default}")
        return True, target, None

    def install(self, advanced_from, target):
        """Install if the range the branch moved over touched a lock file.

        Diffs the range rather than hashing files on disk, so --dry-run can
        answer this without having merged anything.
        """
        changed = git_out(
            "diff", "--name-only", advanced_from, target, "--", *install_lib.LOCKFILES
        )
        if changed is None:
            # A failed diff is not "no lock file changed". Treating it as that
            # would leave the checkout on new code with stale dependencies and no
            # sign anything was missed, which is the silent half of this failure.
            self.bad("could not diff the lock files over that range; install by hand if needed")
            return
        if not changed:
            return
        if self.dry_run:
            self.note("lock file changed in that range; would run install")
            return
        status, log = install_lib.install_deps()
        if status == 0:
            self.ok("lock file changed; dependencies installed")
        elif status == install_lib.NO_LOCKFILE:
            self.note("lock file changed but no recognised lock file remains; nothing installed")
        else:
            # The reason matters here: a missing package manager, a lock file out
            # of sync with package.json, and a registry outage all land on this
            # line.
            self.bad(f"install failed ({last_line(log)}); run it by hand")

    # -------------------------------------------------------- merge proof ---

    def read_merge_proof(self):
        """The bulk pull-request window and the ancestry set.

        Returns the ancestry list, or None when it could not be read. Raises
        nothing: a failure of one signal is reported and the other carries on.
        """
        rows = self.pr_list()
        if rows is None:
            self.note("could not read merged pull requests; using ancestry alone")
        else:
            self.pr_lookup_ok = True
            self.pr_rows = rows
            # A saturated window is a window, not an answer: a repo with more
            # merged pull requests than the limit drops the oldest, so a branch
            # merged before it is absent from the list without being unmerged.
            self.pr_bulk_saturated = len(rows) >= PR_LIMIT
            self.pr_own = prs_lib.own_rows(rows)

        # Ancestry catches the other case: merged locally with no pull request at
        # all. A failed probe must not masquerade as "nothing is merged", which
        # would silently reduce the proof to the pull-request signal alone.
        ancestry = git_lines(
            "branch", "--merged", "refs/remotes/origin/" + self.default, "--format=%(refname:short)"
        )
        if ancestry is None:
            self.note("could not read merged branches; using pull requests alone")
        return ancestry

    def pr_proof_for_branch(self, branch, sha, state):
        """Ask about a single branch, for the case the bulk window cannot answer.

        Returns (proved, state), where state is one of:
          match    a merged pull request from this repo, into the default branch,
                   whose head is exactly this commit
          moved    merged pull requests used this name, none of them at this commit
          none     no merged pull request used this name
          crowded  the window filled up, so "none of them" could not be established
          error    the query did not complete, so nothing was established either way

        The last three are all reasons to keep the branch, but they are different
        statements and the report says which. Reporting a failed query as "none"
        would assert an absence that was never checked. The state can only be
        raised here, never reset: a "moved" from the bulk list is a fact this
        call's failure does not undo.
        """
        rows = self.pr_list(PR_BRANCH_LIMIT, ["--head", branch])
        if rows is None:
            if state == "none":
                state = "error"
            return False, state
        own = prs_lib.own_rows(rows)
        if own and prs_lib.has_match(own, branch, sha):
            return True, "match"
        # A saturated result is a window, not an answer. Concluding "none at this
        # commit" from a truncated list is the mistake this guard exists to fix.
        if len(rows) >= PR_BRANCH_LIMIT:
            return False, "crowded"
        if own:
            state = "moved"
        return False, state

    # ------------------------------------------------------------- prune ---

    def read_worktrees(self):
        """Fill self.worktrees with branch -> worktree path. Returns nothing.

        Raises Skip when the list cannot be read, or when a linked worktree is
        mid-operation; both mean this run must not delete anything.
        """
        out = git_out("worktree", "list", "--porcelain")
        if out is None:
            # Fails closed: an empty map would make every branch look free of a
            # worktree, and this map is what stands between real uncommitted work
            # and a force delete.
            raise Skip("cannot list worktrees")
        current = ""
        for line in out.split("\n"):
            if line.startswith("worktree "):
                current = line[len("worktree ") :]
                # Any linked worktree mid-operation has a detached HEAD, so it
                # maps to no branch and its work would be invisible to the guards
                # below.
                if current != self.top:
                    marker = self.check_in_progress(current)
                    if marker:
                        raise Skip(f"git operation in progress in {current} ({marker})")
            elif line.startswith("branch refs/heads/"):
                self.worktrees.setdefault(line[len("branch refs/heads/") :], current)

    def prune(self, ancestry):
        branches = git_lines("for-each-ref", "--format=%(refname:short)", "refs/heads/")
        if branches is None:
            raise Skip("cannot list local branches")

        for branch in branches:
            if branch == self.default:
                continue
            sha = git_out("rev-parse", "--verify", "--quiet", "refs/heads/" + branch)
            if not sha:
                self.bad(f"kept {branch} (cannot resolve its tip)")
                continue
            proof = self.proof_for(branch, sha, ancestry)
            if proof is None:
                continue
            self.prune_branch(branch, sha, proof)

        if self.pr_unchecked:
            self.bad(
                f"{self.pr_unchecked} branch(es) were never checked against pull requests; "
                "this run is incomplete"
            )

    def proof_for(self, branch, sha, ancestry):
        """The proof this branch landed, or None after reporting why there is none."""
        # Reset per branch rather than relying on the arms below to always run,
        # so a verdict can never carry over from the previous iteration.
        state = "none"
        if self.pr_lookup_ok and self.pr_rows and prs_lib.has_match(self.pr_own, branch, sha):
            return "merged PR"
        if ancestry and branch in ancestry:
            return f"merged into {self.default}"

        # The bulk list can already show this name at another commit, so say so
        # without a second call. The per-branch query below can only raise this.
        if self.pr_lookup_ok and self.pr_own and prs_lib.names_branch(self.pr_own, branch):
            state = "moved"
        # Only worth asking when the bulk window filled up: an unsaturated window
        # already listed every merged pull request, so a second call cannot find
        # one it missed, and asking anyway would be an API call per branch.
        if self.pr_lookup_ok and self.pr_bulk_saturated:
            if self.pr_fallback_off:
                # A previous branch's query already failed. Whatever is wrong is
                # very unlikely to be branch-specific, and a rate limit only gets
                # worse if we keep asking, so stop calling and say these were
                # never checked.
                if state == "none":
                    state = "error"
            else:
                proved, state = self.pr_proof_for_branch(branch, sha, state)
                if proved:
                    return "merged PR"
                if state == "error":
                    self.pr_fallback_off = True

        if state == "moved":
            self.note(f"kept {branch} (merged PRs used this name; none at this commit)")
        elif state == "crowded":
            self.note(f"kept {branch} (too many merged PRs used this name to tell)")
        elif state == "error":
            self.pr_unchecked += 1
            self.bad(f"kept {branch} (could not ask about this branch; unproven, not disproven)")
        else:
            self.note(f"kept {branch} (no merge proof)")
        return None

    def prune_branch(self, branch, sha, proof):
        worktree = self.worktrees.get(branch, "")
        linked = bool(worktree) and worktree != self.top

        # Checked before the tip guard below, so that a branch protected by
        # unfinished work in a worktree is reported for that reason rather than
        # an incidental one. An unreadable worktree counts as occupied: this
        # guard is the only thing between real uncommitted work and a force
        # delete, so it fails closed.
        if linked:
            dirty = git_out("-C", worktree, "status", "--porcelain", "--untracked-files=no")
            if dirty is None:
                self.bad(f"kept {branch} (cannot read worktree {worktree})")
                return
            if dirty:
                self.bad(f"kept {branch} and its worktree {worktree} (uncommitted changes)")
                return

        # A branch pointing at the same commit as origin/<default> has nothing to
        # prune, and is typically one that was just created and not committed to
        # yet.
        if sha == self.tip:
            self.note(f"kept {branch} (already at origin/{self.default}, nothing to prune)")
            return

        # The full SHA is already in hand from the caller, so an unreadable
        # abbreviation costs legibility rather than the recoverability the line
        # exists for. Printing None here would take that away too.
        short = git_out("rev-parse", "--short", branch) or sha

        if linked:
            if self.dry_run:
                self.note(
                    f"would remove worktree {worktree} and delete {branch} ({short}, {proof})"
                )
                return
            if not git_ok("worktree", "remove", worktree):
                self.bad(f"kept {branch} (could not remove worktree {worktree})")
                return
            self.ok(f"removed worktree {worktree}")

        if self.dry_run:
            self.note(f"would delete {branch} ({short}, {proof})")
        elif git_ok("branch", "-D", branch):
            # -D rather than -d because a squash-merged branch is not an ancestor
            # of the default branch. The SHA makes it recoverable:
            # git branch <name> <sha>.
            self.ok(f"deleted {branch} ({short}, {proof})")
        else:
            self.bad(f"could not delete {branch}")

    # -------------------------------------------------------------- drive ---

    def run(self):
        try:
            self.preflight()
            self.default = self.resolve_default_branch()
            if not self.default:
                raise Skip("cannot determine the default branch")

            if not self.fetch():
                return 0

            # Everything below compares against origin/$DEFAULT. If that ref is
            # missing, git reports it by echoing the name back rather than
            # failing loudly, which would turn the tip guard into a silent no-op
            # and empty the ancestry set.
            self.tip = git_out(
                "rev-parse", "--verify", "--quiet", "refs/remotes/origin/" + self.default
            )
            if not self.tip:
                raise Skip(
                    f"origin/{self.default} does not exist locally; nothing to compare against"
                )

            can_advance, target, advanced_from = self.advance()
            if can_advance and not self.no_install and advanced_from:
                self.install(advanced_from, target)

            ancestry = self.read_merge_proof()
            if not self.pr_lookup_ok and ancestry is None:
                self.bad("no way to prove what has merged; skipped pruning entirely")
                return 0

            self.read_worktrees()
            self.prune(ancestry)

            if not self.dry_run:
                git("worktree", "prune")
        except Skip as skipped:
            # A skipped repo prints its reason and exits cleanly. The preflight
            # skips all fire before anything is written; the later ones (a
            # missing origin/<default>, an unreadable ref list) can follow a
            # fetch.
            self.bad(f"skipped: {skipped}")
        return 0


def parse_args(argv):
    """(repo, dry_run, no_install, status). A status that is not None means stop."""
    dry_run = flag_is_set("GH_SYNC_DRY_RUN")
    no_install = flag_is_set("GH_SYNC_NO_INSTALL")
    repo = ""
    for arg in argv:
        if arg == "--dry-run":
            dry_run = True
        elif arg == "--no-install":
            no_install = True
        elif arg in ("-h", "--help"):
            print(__doc__.strip())
            return repo, dry_run, no_install, 0
        elif arg.startswith("-"):
            print(f"unknown flag: {arg}", file=sys.stderr)
            return repo, dry_run, no_install, 2
        else:
            repo = arg
    if not repo:
        print(USAGE, file=sys.stderr)
        return repo, dry_run, no_install, 2
    return repo, dry_run, no_install, None


def use_utf8(stream):
    """Make `stream` write UTF-8, replacing anything it cannot encode.

    Every report line is prefixed with ✓, ✗ or ·, and under a single-byte locale
    (LC_ALL=en_US.ISO8859-1, PYTHONIOENCODING=ascii) writing one raises
    UnicodeEncodeError and the whole sync dies on its first line. A stream that
    has been replaced with something without reconfigure, or that is already
    detached, is left alone rather than turned into a different crash.
    """
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass


def main(argv):
    use_utf8(sys.stdout)
    use_utf8(sys.stderr)
    repo, dry_run, no_install, status = parse_args(argv)
    if status is not None:
        return status
    try:
        result = SyncRepo(repo, dry_run=dry_run, no_install=no_install).run()
        # Forces the write now, while BrokenPipeError still lands in the handler
        # below. Left implicit, buffered output is flushed during interpreter
        # shutdown instead, which prints its own "Exception ignored in" trace.
        sys.stdout.flush()
    except BrokenPipeError:
        # `gh-sync-repo.py <repo> | head` closes the pipe early. That is the
        # reader's business, not a failure here. Both descriptors go to devnull,
        # not just stdout, so nothing the interpreter still tries to flush on the
        # way out can resurface as a broken-pipe trace either.
        devnull = os.open(os.devnull, os.O_WRONLY)
        try:
            os.dup2(devnull, sys.stdout.fileno())
            os.dup2(devnull, sys.stderr.fileno())
        finally:
            os.close(devnull)
        return 0
    return result


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
