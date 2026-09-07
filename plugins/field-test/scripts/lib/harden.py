"""State-file transformations and argument validation for ft-harden-state.py.

Two kinds of thing live here. The jq the shell ran -- the add-target filter, the
`set` filter, the `next` selection, and the shape check that decides whether a
file is a hardening run at all -- and the validation the shell did with regexes
and substring tests against space-padded vocabularies. Both are plain functions,
so each arm is its own branch in the coverage report and its own unit test in
`tests/field-test/test_harden.py`, which a jq program counted as one line could
not be; see `.claude/rules/type-jq.md`.

Nothing here touches the filesystem or the environment: the functions take a
state document (the parsed JSON) and return a new value or raise `Invalid`. The
script owns reading, writing, and exit codes.
"""

from __future__ import annotations

import json
import re

STATUSES = ("pending", "running", "paused", "done", "failed")
PHASES = ("field-test", "verify", "fix", "review", "merge", "summary", "done")
FIELDS = (
    "status",
    "phase",
    "issues",
    "pr",
    "review_rounds",
    "merge_sha",
    "question",
    "summary",
    "repo",
)
# Stored as a JSON number or null rather than a string, and the fields `bump`
# will add one to. `review_rounds` is the count of review rounds the target has
# had, recorded here so the harden skill can bound the review phase at one
# repeat across a resumed session: a count written as the string "1" would
# compare against a number and start the loop over.
NUMERIC_FIELDS = ("pr", "review_rounds")
EFFORTS = ("low", "medium", "high")
MODELS = ("haiku", "sonnet", "opus", "fable", "inherit")

# A target that is neither done nor failed. A paused target is still returned: it
# is waiting on a decision, and the caller has to see it and stop rather than
# step over it and bury the question under the next round.
UNFINISHED = ("pending", "running", "paused")

VERSION = 1

DIGITS = re.compile(r"^[0-9]+$")


def listed(names) -> str:
    """A vocabulary the way the shell printed it: space-padded, both ends.

    Kept because the messages are a contract the tests quote. The padding was
    load-bearing in bash, where membership was a substring test; here it is only
    how the message reads.
    """
    return " " + " ".join(names) + " "


class Invalid(Exception):
    """A value the script must refuse, with the message and exit code to use.

    Usage errors exit 2, the way the shell script's `die "..." 2` did. The ones
    that are not usage errors carry status 1: `set` naming a target that was
    never added, and `next` naming a target the state file describes in a way no
    command could act on. A state file that is not a hardening run at all raises
    nothing here -- it is `is_state` returning False, and the script owns that
    exit.
    """

    def __init__(self, message: str, status: int = 2) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


# --- naming ------------------------------------------------------------------


def check_skill(command: str, skill: str) -> str:
    """The <plugin:skill> every command takes, or a refusal naming the command."""
    if not skill or skill.startswith("-"):
        raise Invalid(f"{command} needs a <plugin:skill> target")
    if ":" not in skill:
        raise Invalid(f"target must be plugin:skill, got: {skill}")
    return skill


def file_name(skill: str) -> str:
    """gh:shepherd becomes gh__shepherd.json, the shape ws-state uses for owner/name."""
    return skill.replace("/", "_").replace(":", "__") + ".json"


# --- shape -------------------------------------------------------------------


def is_state(document) -> bool:
    """Whether a parsed document is a hardening run.

    The shell asked only whether the top level was an object holding a `targets`
    array, which let a file through that every later step then had to guard
    against or crash on. This also asks that each target is an object, because
    `add-target`, `set` and `next` all index one.
    """
    if not isinstance(document, dict):
        return False
    targets = document.get("targets")
    return isinstance(targets, list) and all(isinstance(entry, dict) for entry in targets)


def new_state(skill: str, created: str, model: str, effort: str) -> dict:
    """The document `init` writes."""
    return {
        "version": VERSION,
        "skill": skill,
        "created": created,
        "model": model,
        "effort": effort,
        "targets": [],
    }


def target_record(path: str, repo: str) -> dict:
    return {
        "path": path,
        "repo": repo or None,
        "status": "pending",
        "phase": "field-test",
        "issues": [],
        "pr": None,
        "review_rounds": None,
        "merge_sha": None,
        "question": None,
        "summary": None,
    }


# --- init --------------------------------------------------------------------


def check_model(model: str) -> str:
    if model not in MODELS:
        raise Invalid(f"init: model must be one of{listed(MODELS)}got: {model}")
    return model


def check_effort(effort: str) -> str:
    if effort not in EFFORTS:
        raise Invalid(f"init: effort must be low, medium, or high, got: {effort}")
    return effort


# --- add-target --------------------------------------------------------------


def add_target(document, path: str, repo: str):
    """The state with the target appended, or unchanged if it is already there.

    Targets are an ordered list, not a set keyed by path, because the order is
    the plan: the loop works them front to back and a resumed session has to pick
    up where the last one stopped. Appending a path that is already listed is a
    no-op rather than an error, so a re-run of the same setup does not duplicate
    work.
    """
    if any(target.get("path") == path for target in document["targets"]):
        return document
    document["targets"] = document["targets"] + [target_record(path, repo)]
    return document


# --- set ---------------------------------------------------------------------


def check_field(field: str) -> str:
    if field not in FIELDS:
        raise Invalid(f"set: unknown field: {field} (one of:{listed(FIELDS)})")
    return field


def check_status(value: str) -> str:
    # Whole words only. A target whose status is "pending done" is one `next`
    # would skip without a word, which is why the shell tested against a padded
    # list and why two statuses in one value is refused rather than stored.
    if value not in STATUSES:
        raise Invalid(f"set: invalid status: {value} (one of:{listed(STATUSES)})")
    return value


def check_phase(value: str) -> str:
    if value not in PHASES:
        raise Invalid(f"set: invalid phase: {value} (one of:{listed(PHASES)})")
    return value


def json_value(raw: str):
    """A --json value, parsed, or the refusal the shell's `jq .` check produced."""
    if raw == "":
        raise Invalid(f"set: --json value is not valid JSON: {raw}")
    try:
        return json.loads(raw)
    except ValueError:
        raise Invalid(f"set: --json value is not valid JSON: {raw}") from None


def numeric_value(field: str, raw: str):
    """A number field's value, or None. --json is implied for these fields."""
    if raw == "null":
        return None
    if not DIGITS.match(raw):
        raise Invalid(f"set: {field} takes a number or null, got: {raw}")
    return int(raw)


def issues_value(raw: str):
    """The issues array. --json is implied for the field.

    Valid JSON that is not an array is named as such; invalid JSON falls through
    to `json_value` and is named as invalid JSON, which is the distinction the
    shell drew too. `null` is refused here where the shell stored it: jq -e
    reports false for null, so the shell's array check never saw it, and an
    issues field holding null is a list the loop cannot read back.
    """
    try:
        document = json.loads(raw)
    except ValueError:
        return json_value(raw)
    if not isinstance(document, list):
        raise Invalid(f"set: issues takes a JSON array, got: {raw}")
    return document


def field_value(field: str, raw: str, mode: str):
    """The value to store for one field, validated per the field's own rule."""
    check_field(field)
    if field == "status":
        check_status(raw)
    if field == "phase":
        check_phase(raw)
    if field in NUMERIC_FIELDS:
        return numeric_value(field, raw)
    if field == "issues":
        return issues_value(raw)
    if mode == "--json":
        return json_value(raw)
    return raw


def set_field(document, path: str, field: str, value):
    """The state with one target's field replaced. Raises for a target not in it."""
    for target in document["targets"]:
        if target.get("path") == path:
            target[field] = value
            return document
    raise Invalid(f"set: unknown target: {path}", 1)


# --- bump --------------------------------------------------------------------


def check_numeric_field(field: str) -> None:
    """`bump` is arithmetic, so it takes only the fields that hold a number."""
    if field not in NUMERIC_FIELDS:
        raise Invalid(f"bump: {field} is not a numeric field (one of:{listed(NUMERIC_FIELDS)})")


def bump_field(document, path: str, field: str) -> int:
    """Add one to a numeric field of one target, and return what it now holds.

    The harden loop counts review rounds, and every count it keeps is one a
    resumed session has to agree with. Reading the value, adding one, and
    writing it back would put that arithmetic in the skill, where a tick that
    stopped between the read and the write leaves the count behind by one and
    the next round repeats a review already run.

    A field that is null or absent counts as 0, which is what a target added
    before the field existed carries. A field holding something that is not a
    whole number is refused rather than replaced: the state file was written by
    something other than this script, and overwriting it would lose whatever
    that was.
    """
    for target in document["targets"]:
        if target.get("path") == path:
            current = target.get(field)
            if current is None:
                current = 0
            # bool before int: True is an int in Python, and a field holding one
            # is not a count anybody meant to increment.
            if isinstance(current, bool) or not isinstance(current, int):
                raise Invalid(f"bump: {field} is not a number on {path}: {current}", 1)
            target[field] = current + 1
            return target[field]
    raise Invalid(f"bump: unknown target: {path}", 1)


# --- next --------------------------------------------------------------------


def target_name(target, index: int) -> str:
    """What to call one target in a refusal: its path, or where it sits."""
    path = target.get("path")
    return path if isinstance(path, str) and path else f"target {index + 1}"


def check_target(target, index: int) -> None:
    """Refuse a target `next` cannot read, naming it and the field.

    A status outside the vocabulary is neither finished nor unfinished, so `next`
    stepped over it and printed nothing once it was the last one left -- and the
    skill reads no output as "every target is done" and goes to the summary with
    the work not started. A path that is not a string is the same silence one
    step later: `next` printed an empty line, or the loop asked `set` about a
    target it could not name. Either way the state file is corrupt, and saying so
    is the only safe answer.
    """
    status = target.get("status")
    if status not in STATUSES:
        raise Invalid(
            f"next: {target_name(target, index)}: status is not one of{listed(STATUSES)}"
            f"got: {json.dumps(status)}",
            1,
        )
    if not isinstance(target.get("path"), str) or not target.get("path"):
        raise Invalid(
            f"next: {target_name(target, index)}: path is not a string, "
            f"got: {json.dumps(target.get('path'))}",
            1,
        )


def next_target(document) -> str:
    """The path of the first target still to do, or "" when the list is exhausted.

    Every target is checked, not only the ones reached before the answer: a
    corrupt target later in the list is a target the loop would step over on the
    round after this one, and by then the run has already acted on this answer.
    """
    for index, target in enumerate(document["targets"]):
        check_target(target, index)
    for target in document["targets"]:
        if target.get("status") in UNFINISHED:
            return target["path"]
    return ""
