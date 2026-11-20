"""Every deploy-root reader takes `BOTCUBE_DEPLOY_ROOT` and `BOTCUBE_DEPLOY_REPOSITORY_ROOT`, and no longer the old names."""

import json
import os
import subprocess
from pathlib import Path

import deploy_identity
import pytest

INFRA = Path(__file__).resolve().parents[1]
EXAMPLE_IDENTITY = INFRA.parent / 'examples/public/deploy/identity.json'
NAME, REPOSITORY = 'BOTCUBE_DEPLOY_ROOT', 'BOTCUBE_DEPLOY_REPOSITORY_ROOT'
OLD_NAME, OLD_REPOSITORY = 'CARTRIDGE_DEPLOY_ROOT', 'CARTRIDGE_REPOSITORY_ROOT'
ALL_NAMES = (NAME, REPOSITORY, OLD_NAME, OLD_REPOSITORY)


def deploy_root(tmp_path: Path, name: str) -> Path:
    """A deploy root whose names are its own, so a reader that found it shows them."""
    identity = json.loads(EXAMPLE_IDENTITY.read_text())
    identity['aws']['ecs'].update(cluster=f'{name}-cluster', deployRoleName=f'{name}-role', originPullClientSecretName=f'{name}-secret')
    root = tmp_path / name
    root.mkdir()
    (root / 'identity.json').write_text(json.dumps(identity))
    return root


def environment(**names: str) -> dict[str, str]:
    """This process's environment with only the deploy-root names given."""
    kept = {key: value for key, value in os.environ.items() if key not in ALL_NAMES}
    return {**kept, **names}


def test_the_identity_loads_from_the_deploy_root(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv(OLD_NAME, raising=False)
    monkeypatch.setenv(NAME, str(deploy_root(tmp_path, NAME)))
    assert deploy_identity.load_identity()['aws']['ecs']['cluster'] == f'{NAME}-cluster'


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
    result = subprocess.run(['bash', str(INFRA / 'ecs' / script)], env=environment(**{NAME: str(root)}, **path),
                            capture_output=True, text=True, check=False)
    assert result.returncode != 0
    assert call.format(name=NAME) in calls.read_text()


@pytest.mark.integration
def test_the_origin_pull_bootstrap_reads_both_roots(tmp_path: Path) -> None:
    root = deploy_root(tmp_path, NAME)
    path, _ = fake_aws(tmp_path, exit_code=0)
    result = subprocess.run(['bash', str(INFRA / 'ecs/bootstrap-origin-pull.sh')],
                            env=environment(**{NAME: str(root), REPOSITORY: str(tmp_path)}, **path),
                            capture_output=True, text=True, check=False)
    assert (result.returncode, result.stderr) == (1, f'{NAME}-secret already exists; pass --rotate to issue new material\n')


@pytest.mark.integration
@pytest.mark.parametrize('old', [False, True])
@pytest.mark.parametrize(('script', 'message'), [
    ('bootstrap-deploy-role.sh', 'BOTCUBE_DEPLOY_ROOT must point to the active deploy directory'),
    ('bootstrap-rollback-role.sh', 'BOTCUBE_DEPLOY_ROOT must point to the active deploy directory'),
    ('bootstrap-origin-pull.sh', 'BOTCUBE_DEPLOY_REPOSITORY_ROOT must point to the checkout root'),
])
def test_a_bootstrap_without_its_roots_fails_loud(tmp_path: Path, script: str, message: str, old: bool) -> None:
    names = {OLD_NAME: str(deploy_root(tmp_path, OLD_NAME)), OLD_REPOSITORY: str(tmp_path)} if old else {}
    result = subprocess.run(['bash', str(INFRA / 'ecs' / script)], env=environment(**names), capture_output=True, text=True, check=False)
    assert result.returncode != 0
    assert message in result.stderr
