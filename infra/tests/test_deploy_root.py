"""Every deploy-root reader takes `BOTCUBE_DEPLOY_ROOT`, and the old `CARTRIDGE_DEPLOY_ROOT` until its setters move."""

import json
import os
import subprocess
from pathlib import Path

import deploy_identity
import pytest

INFRA = Path(__file__).resolve().parents[1]
EXAMPLE_IDENTITY = INFRA.parent / 'examples/public/deploy/identity.json'
NAMES = ('BOTCUBE_DEPLOY_ROOT', 'CARTRIDGE_DEPLOY_ROOT')
REPOSITORY_NAMES = ('BOTCUBE_DEPLOY_REPOSITORY_ROOT', 'CARTRIDGE_REPOSITORY_ROOT')


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
    kept = {key: value for key, value in os.environ.items() if key not in NAMES + REPOSITORY_NAMES}
    return {**kept, **names}


@pytest.mark.parametrize('name', NAMES)
def test_the_identity_loads_from_either_name(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, name: str) -> None:
    for each in NAMES:
        monkeypatch.delenv(each, raising=False)
    monkeypatch.setenv(name, str(deploy_root(tmp_path, name)))
    assert deploy_identity.load_identity()['aws']['ecs']['cluster'] == f'{name}-cluster'


def test_the_new_name_wins_over_the_old(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for name in NAMES:
        monkeypatch.setenv(name, str(deploy_root(tmp_path, name)))
    assert deploy_identity.deploy_root() == tmp_path / 'BOTCUBE_DEPLOY_ROOT'


def test_a_missing_deploy_root_fails_loud(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in NAMES:
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(RuntimeError, match='BOTCUBE_DEPLOY_ROOT must point to the active deploy directory'):
        deploy_identity.deploy_root()


@pytest.mark.integration
@pytest.mark.parametrize('name', NAMES)
def test_the_github_environment_export_reads_either_name(tmp_path: Path, name: str) -> None:
    root = deploy_root(tmp_path, name)
    result = subprocess.run(['node', str(INFRA / 'export-github-env.mjs')], env=environment(**{name: str(root)}),
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
@pytest.mark.parametrize('name', NAMES)
@pytest.mark.parametrize(('script', 'call'), [
    ('bootstrap-deploy-role.sh', 'iam get-role --role-name {name}-role'),
    ('bootstrap-rollback-role.sh', '--cluster {name}-cluster'),
])
def test_the_role_bootstraps_read_the_identity_from_either_name(tmp_path: Path, name: str, script: str, call: str) -> None:
    root = deploy_root(tmp_path, name)
    path, calls = fake_aws(tmp_path, exit_code=1)
    result = subprocess.run(['bash', str(INFRA / 'ecs' / script)], env=environment(**{name: str(root)}, **path),
                            capture_output=True, text=True, check=False)
    assert result.returncode != 0
    assert call.format(name=name) in calls.read_text()


@pytest.mark.integration
@pytest.mark.parametrize(('name', 'repository'), list(zip(NAMES, REPOSITORY_NAMES, strict=True)))
def test_the_origin_pull_bootstrap_reads_either_pair_of_names(tmp_path: Path, name: str, repository: str) -> None:
    root = deploy_root(tmp_path, name)
    path, _ = fake_aws(tmp_path, exit_code=0)
    result = subprocess.run(['bash', str(INFRA / 'ecs/bootstrap-origin-pull.sh')],
                            env=environment(**{name: str(root), repository: str(tmp_path)}, **path),
                            capture_output=True, text=True, check=False)
    assert (result.returncode, result.stderr) == (1, f'{name}-secret already exists; pass --rotate to issue new material\n')


@pytest.mark.integration
@pytest.mark.parametrize(('script', 'message'), [
    ('bootstrap-deploy-role.sh', 'BOTCUBE_DEPLOY_ROOT must point to the active deploy directory'),
    ('bootstrap-rollback-role.sh', 'BOTCUBE_DEPLOY_ROOT must point to the active deploy directory'),
    ('bootstrap-origin-pull.sh', 'BOTCUBE_DEPLOY_REPOSITORY_ROOT must point to the checkout root'),
])
def test_a_bootstrap_without_its_roots_fails_loud(script: str, message: str) -> None:
    result = subprocess.run(['bash', str(INFRA / 'ecs' / script)], env=environment(), capture_output=True, text=True, check=False)
    assert result.returncode != 0
    assert message in result.stderr
