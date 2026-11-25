"""Every deploy-root reader takes `BOTCUBE_DEPLOY_ROOT`, and no longer the old names or a repository root."""

import json
import os
import subprocess
from pathlib import Path

import deploy_identity
import pytest

INFRA = Path(__file__).resolve().parents[1]
PUBLIC_EXAMPLE = INFRA.parent / 'examples/public/deploy'
NAME, RETIRED_REPOSITORY = 'BOTCUBE_DEPLOY_ROOT', 'BOTCUBE_DEPLOY_REPOSITORY_ROOT'
OLD_NAME, OLD_REPOSITORY = 'LEGACY_DEPLOY_ROOT', 'LEGACY_REPOSITORY_ROOT'
# The deploy workflow's OIDC subject, which the release tooling gives the deploy-role bootstrap.
SUBJECT = 'GITHUB_OIDC_SUBJECT'
ALL_NAMES = (NAME, RETIRED_REPOSITORY, OLD_NAME, OLD_REPOSITORY, SUBJECT)


def deploy_root(tmp_path: Path, name: str) -> Path:
    """A deploy root beside the public example's BotCube Config, named `own-<name>`, so a reader that found it shows its names."""
    config = json.loads(subprocess.check_output([
        'node', str(INFRA.parent / 'config/cli.ts'), 'resolve', str(PUBLIC_EXAMPLE.parent / 'botcube.yaml'),
    ]))['config']
    config.update(name=f'own-{name.lower().replace("_", "-")}')
    config['names'].update(clusterName=f'{name.lower()}-cluster', deployRoleName=f'{name.lower()}-role')
    root = tmp_path / name / 'deploy'
    root.mkdir(parents=True)
    (root.parent / 'botcube.yaml').write_text(json.dumps(config))
    return root


def environment(**names: str) -> dict[str, str]:
    """This process's environment with only the deploy-root names given."""
    kept = {key: value for key, value in os.environ.items() if key not in ALL_NAMES}
    return {**kept, **names}


def test_ops_read_the_deploys_physical_names(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    artifact = tmp_path / 'resolved.json'
    artifact.write_text(json.dumps({
        'formatVersion': 1, 'config': {'name': 'own-deployment', 'names': {'clusterName': 'source-cluster'}},
        'physicalNames': {'clusterName': 'resolved-cluster'},
    }))
    monkeypatch.setenv('BOTCUBE_CONFIG', str(artifact))
    monkeypatch.delenv(NAME, raising=False)

    assert deploy_identity.load_deployment()['physicalNames']['clusterName'] == 'resolved-cluster'


@pytest.mark.parametrize(('contents', 'message'), [
    ('{"formatVersion": 2}', 'expected formatVersion 1, got 2'),
    ('{"name": "source"}', 'expected formatVersion 1, got None'),
    ('name: invalid', 'Expecting value'),
])
def test_ops_reject_an_unsupported_artifact(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, contents: str, message: str) -> None:
    artifact = tmp_path / 'resolved.json'
    artifact.write_text(contents)
    monkeypatch.setenv('BOTCUBE_CONFIG', str(artifact))
    with pytest.raises(RuntimeError, match=message):
        deploy_identity.load_deployment()


def test_ops_require_a_resolved_locator_even_with_a_deploy_root(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('BOTCUBE_CONFIG', raising=False)
    monkeypatch.setenv(NAME, str(PUBLIC_EXAMPLE))
    with pytest.raises(RuntimeError, match='BOTCUBE_CONFIG must point to the resolved BotCube Config'):
        deploy_identity.load_deployment()


@pytest.mark.integration
def test_the_github_environment_export_reads_a_migrated_deploy_root() -> None:
    result = subprocess.run(['node', str(INFRA / 'export-github-env.mjs')], env=environment(**{NAME: str(PUBLIC_EXAMPLE)}),
                            capture_output=True, text=True, check=True)
    assert 'CLOUDFORMATION_STACK_FAMILY=bot-cube\n' in result.stdout


@pytest.mark.parametrize('names', [(), (OLD_NAME,)])
def test_a_missing_deploy_root_fails_loud(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, names: tuple[str, ...]) -> None:
    for name in (NAME, OLD_NAME):
        monkeypatch.delenv(name, raising=False)
    for name in names:
        monkeypatch.setenv(name, str(deploy_root(tmp_path, name)))
    with pytest.raises(RuntimeError, match='BOTCUBE_DEPLOY_ROOT must point to the active deploy directory'):
        deploy_identity.deploy_root()


@pytest.mark.integration
def test_the_github_environment_export_reads_the_deploy_root(tmp_path: Path) -> None:
    root = deploy_root(tmp_path, NAME)
    result = subprocess.run(['node', str(INFRA / 'export-github-env.mjs')], env=environment(**{NAME: str(root)}),
                            capture_output=True, text=True, check=True)
    assert 'AWS_ACCOUNT_ID=000000000000\n' in result.stdout


def fake_aws(tmp_path: Path, exit_code: int) -> tuple[dict[str, str], Path]:
    """A PATH whose `aws` records its arguments and exits with `exit_code`, and the file it records to."""
    bin_dir, calls = tmp_path / 'bin', tmp_path / 'aws-calls'
    bin_dir.mkdir()
    (bin_dir / 'aws').write_text(f'#!/bin/sh\necho "$@" >> {calls}\nexit {exit_code}\n')
    (bin_dir / 'aws').chmod(0o755)
    return {'PATH': f'{bin_dir}:{os.environ["PATH"]}'}, calls


@pytest.mark.integration
@pytest.mark.parametrize(('script', 'call'), [
    ('bootstrap-deploy-role.sh', 'iam get-role --role-name {name}-role'),
    ('bootstrap-rollback-role.sh', '--cluster {name}-cluster'),
])
def test_the_role_bootstraps_read_the_identity_from_the_deploy_root(tmp_path: Path, script: str, call: str) -> None:
    root = deploy_root(tmp_path, NAME)
    path, calls = fake_aws(tmp_path, exit_code=1)
    result = subprocess.run(['bash', str(INFRA / 'ecs' / script)], env=environment(**{NAME: str(root), SUBJECT: 'repo:example/bot:environment:production'}, **path),
                            capture_output=True, text=True, check=False)
    assert result.returncode != 0
    assert call.format(name=NAME.lower()) in calls.read_text()


@pytest.mark.integration
def test_the_deploy_role_bootstrap_takes_the_workflow_subject_from_the_release_tooling_not_the_deploy_root(tmp_path: Path) -> None:
    path, calls = fake_aws(tmp_path, exit_code=1)
    result = subprocess.run(['bash', str(INFRA / 'ecs/bootstrap-deploy-role.sh')], env=environment(**{NAME: str(deploy_root(tmp_path, NAME))}, **path),
                            capture_output=True, text=True, check=False)
    assert result.returncode != 0
    assert 'GITHUB_OIDC_SUBJECT must name the OIDC subject of the workflow that deploys' in result.stderr
    assert not calls.exists()


@pytest.mark.integration
def test_the_origin_pull_bootstrap_reads_the_identity_from_the_deploy_root(tmp_path: Path) -> None:
    root = deploy_root(tmp_path, NAME)
    path, _ = fake_aws(tmp_path, exit_code=0)
    result = subprocess.run(['bash', str(INFRA / 'ecs/bootstrap-origin-pull.sh')],
                            env=environment(**{NAME: str(root)}, **path),
                            capture_output=True, text=True, check=False)
    assert (result.returncode, result.stderr) == (1, '/own-botcube-deploy-root/cloudflare/origin-pull-client already exists; pass --rotate to issue new material\n')


@pytest.mark.integration
@pytest.mark.parametrize('old', [False, True])
@pytest.mark.parametrize(('script', 'message'), [
    ('bootstrap-deploy-role.sh', 'BOTCUBE_DEPLOY_ROOT must point to the active deploy directory'),
    ('bootstrap-rollback-role.sh', 'BOTCUBE_DEPLOY_ROOT must point to the active deploy directory'),
    ('bootstrap-origin-pull.sh', 'BOTCUBE_DEPLOY_ROOT must point to the active deploy directory'),
])
def test_a_bootstrap_without_its_deploy_root_fails_loud(tmp_path: Path, script: str, message: str, old: bool) -> None:
    names = {OLD_NAME: str(deploy_root(tmp_path, OLD_NAME)), OLD_REPOSITORY: str(tmp_path), RETIRED_REPOSITORY: str(tmp_path)} if old else {}
    result = subprocess.run(['bash', str(INFRA / 'ecs' / script)], env=environment(**names), capture_output=True, text=True, check=False)
    assert result.returncode != 0
    assert message in result.stderr
