"""Black-box tests for ft-enterprise.py.

Ported from `spec/field-test/enterprise_spec.sh`. The answer here decides whether
a repository's name is published, so every arm that can produce `inside: false`
keeps its own test: an outright failure, a token without the scope, a missing
remote, and a genuine no. "requires jq" did not come across; there is no jq to
require.
"""

from __future__ import annotations

import json

import pytest
from conftest import FT_ENTERPRISE, STUB_BIN, ft_fixture_enterprise, ft_fixture_repo

pytestmark = pytest.mark.usefixtures("ft_sandbox")


@pytest.fixture
def repos(ft_sandbox):
    """The plugin checkout and the repository under test, both real repositories."""

    def build(plugin_form="ssh", target_slug="acme-tools/widgets", target_form="ssh"):
        ft_fixture_repo(ft_sandbox.path / "plugin", "acme-org/plugins", plugin_form)
        ft_fixture_repo(ft_sandbox.path / "target", target_slug, target_form)
        return str(ft_sandbox.path / "plugin"), str(ft_sandbox.path / "target")

    return build


def answer(result):
    assert result.status == 0, result.stderr
    return json.loads(result.stdout)


def test_prints_usage_for_help(run_script):
    """prints usage for --help"""
    result = run_script(FT_ENTERPRISE, "--help")
    assert result.status == 0
    assert "ft-enterprise.py <plugin-repo-dir>" in result.stdout


def test_needs_both_directories(ft_sandbox, run_script):
    """needs both directories"""
    result = run_script(FT_ENTERPRISE, str(ft_sandbox.path))
    assert result.status == 2
    assert "expected <plugin-repo-dir> <target-repo-dir>" in result.stderr


def test_says_inside_when_both_owners_are_in_one_enterprise(repos, run_script):
    """says inside when both owners are organizations in one enterprise"""
    document = answer(run_script(FT_ENTERPRISE, *repos()))
    assert document["inside"] is True
    assert document["enterprise"] == "acme"
    assert "both organizations in the acme enterprise" in document["reason"]


def test_reads_https_remotes(repos, run_script):
    """reads https remotes as well as ssh ones"""
    document = answer(run_script(FT_ENTERPRISE, *repos("https", "acme-tools/widgets", "https")))
    assert document["inside"] is True


def test_reads_a_remote_written_through_an_ssh_host_alias(repos, run_script):
    """reads a remote written through an ssh host alias

    A machine holding two GitHub accounts writes remotes as
    git@github.com-work:..., which a parse anchored on the literal "github.com"
    reads as the owner -work:acme. The run would be reported as outside its own
    enterprise and every name redacted.
    """
    document = answer(run_script(FT_ENTERPRISE, *repos("alias", "acme-tools/widgets", "alias")))
    assert document["inside"] is True
    assert document["plugin_owner"] == "acme-org"


def test_follows_a_second_page_of_organizations(ft_sandbox, repos, run_script):
    """follows a second page of organizations rather than answering from the first"""
    ft_fixture_enterprise(ft_sandbox.gh_dir, "paged")
    assert answer(run_script(FT_ENTERPRISE, *repos()))["inside"] is True


def test_keeps_looking_past_an_enterprise_holding_one_owner(ft_sandbox, repos, run_script):
    """keeps looking past an enterprise that holds only one of the owners"""
    ft_fixture_enterprise(ft_sandbox.gh_dir, "second")
    document = answer(run_script(FT_ENTERPRISE, *repos()))
    assert document["inside"] is True
    assert document["enterprise"] == "acme"


def test_says_outside_when_the_target_owner_is_in_no_enterprise(repos, run_script):
    """says outside when the target owner is in no enterprise of yours"""
    document = answer(run_script(FT_ENTERPRISE, *repos("ssh", "someone-else/thing")))
    assert document["inside"] is False
    assert document["enterprise"] is None
    assert "not both organizations" in document["reason"]


def test_says_outside_when_the_enterprise_holds_one_owner(ft_sandbox, repos, run_script):
    """says outside when the enterprise holds only one of the two owners"""
    ft_fixture_enterprise(ft_sandbox.gh_dir, "neither")
    assert answer(run_script(FT_ENTERPRISE, *repos()))["inside"] is False


def test_fails_closed_when_gh_fails(ft_sandbox, repos, run_script):
    """fails closed when gh fails, and keeps the error"""
    ft_fixture_enterprise(ft_sandbox.gh_dir, "error")
    document = answer(run_script(FT_ENTERPRISE, *repos()))
    assert document["inside"] is False
    assert "could not read the enterprise list" in document["reason"]
    assert "required scopes" in document["reason"]


def test_fails_closed_when_the_query_answers_without_enterprises(ft_sandbox, repos, run_script):
    """fails closed when the query answers without an enterprises node"""
    ft_fixture_enterprise(ft_sandbox.gh_dir, "empty")
    document = answer(run_script(FT_ENTERPRISE, *repos()))
    assert document["inside"] is False
    assert "read:enterprise" in document["reason"]


def test_fails_closed_when_the_plugin_checkout_has_no_remote(repos, run_script):
    """fails closed when the plugin checkout has no github remote"""
    document = answer(run_script(FT_ENTERPRISE, *repos("none")))
    assert document["inside"] is False
    assert "no github origin remote in the plugin checkout" in document["reason"]


def test_fails_closed_when_the_repository_under_test_has_no_remote(repos, run_script):
    """fails closed when the repository under test has no github remote"""
    document = answer(run_script(FT_ENTERPRISE, *repos("ssh", "acme-tools/widgets", "none")))
    assert document["inside"] is False
    assert "no github origin remote in the repository under test" in document["reason"]


def test_reports_both_owners(repos, run_script):
    """reports both owners so the reason can be read without the repositories"""
    document = answer(run_script(FT_ENTERPRISE, *repos()))
    assert document["plugin_owner"] == "acme-org"
    assert document["target_owner"] == "acme-tools"


def test_fails_closed_when_gh_is_not_installed(ft_sandbox, repos, run_script):
    """fails closed when gh itself cannot be run

    New with the port: the shell read gh's failure and its absence through the
    same non-zero exit; Python has to catch the OSError to keep the answer.
    """
    plugin, target = repos()
    ft_sandbox.setenv("FT_GH", ft_sandbox.path / "no-such-gh")
    document = answer(run_script(FT_ENTERPRISE, plugin, target))
    assert document["inside"] is False
    assert "could not read the enterprise list" in document["reason"]


def test_fails_closed_when_the_query_answers_with_something_unreadable(
    ft_sandbox, repos, run_script
):
    """fails closed when gh answers with something that is not JSON

    New with the port, and the same failure as a missing enterprises node: what
    could not be read must not be read as "no enterprise", which publishes a name.
    """
    plugin, target = repos()
    stub = ft_sandbox.path / "bin" / "gh"
    stub.parent.mkdir(parents=True, exist_ok=True)
    stub.write_text("#!/bin/sh\nprintf 'not json'\n")
    stub.chmod(0o755)
    ft_sandbox.setenv("FT_GH", stub)
    document = answer(run_script(FT_ENTERPRISE, plugin, target))
    assert document["inside"] is False
    assert "read:enterprise" in document["reason"]


def test_answers_from_the_first_page_when_the_second_cannot_be_read(ft_sandbox, repos, run_script):
    """stops paginating when a later page fails, rather than raising

    New with the port: the shell broke out of the loop on a non-zero gh; the
    same has to hold when the answer comes back unreadable instead.
    """
    plugin, target = repos()
    stub = ft_sandbox.path / "bin" / "gh"
    stub.parent.mkdir(parents=True, exist_ok=True)
    real = STUB_BIN / "gh"
    stub.write_text(
        "#!/bin/sh\n"
        "case \"$*\" in *slug=*) printf 'not json'; exit 0 ;; esac\n"
        f'exec "{real}" "$@"\n'
    )
    stub.chmod(0o755)
    ft_fixture_enterprise(ft_sandbox.gh_dir, "paged")
    ft_sandbox.setenv("FT_GH", stub)
    document = answer(run_script(FT_ENTERPRISE, plugin, target))
    assert document["inside"] is False
    assert "not both organizations" in document["reason"]
