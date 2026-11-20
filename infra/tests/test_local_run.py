"""The local stack's entrypoint (local/run.sh) picks its Compose files and runs nothing before Compose."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs a real subprocess, server or socket (ADR 0083 decision 1).
pytestmark = pytest.mark.integration


@pytest.fixture
def local_checkout(tmp_path: Path) -> Path:
    cube = tmp_path / 'botcube'
    destination = cube / 'infra/local/run.sh'
    destination.parent.mkdir(parents=True)
    shutil.copyfile(Path(__file__).resolve().parents[1] / 'local/run.sh', destination)
    doubles = tmp_path / 'bin'
    doubles.mkdir()
    docker = doubles / 'docker'
    docker.write_text('''#!/bin/sh
if [ -n "${TRUST_CAPTURE:-}" ]; then
  printf '%s|%s\\n' "${NODE_EXTRA_CA_CERTS:-}" "${SSL_CERT_FILE:-}" >> "$TRUST_CAPTURE"
fi
printf '%s\\n' "$@"
''')
    docker.chmod(0o755)
    return cube


def run_local(cube: Path, **environment: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['bash', str(cube / 'infra/local/run.sh'), '-d', 'harness'],
        cwd=cube.parent,
        env={**os.environ, 'PATH': f'{cube.parent}/bin:{os.environ["PATH"]}', **environment},
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.parametrize('symlinked', [False, True])
def test_fresh_local_checkout_runs_compose_with_its_arguments(local_checkout: Path, symlinked: bool) -> None:
    cube = local_checkout
    if symlinked:
        alias = local_checkout.parent / 'ancestor'
        alias.symlink_to(local_checkout.parent, target_is_directory=True)
        cube = alias / local_checkout.name

    result = run_local(cube)

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == [
        'compose', '-f', str(cube / 'infra/local/compose.yml'),
        'up', '--build', '-d', 'harness',
    ]
    assert not (local_checkout / 'harness/deepagents/.tool-dist').exists()


def test_production_artifacts_add_the_production_overlay(local_checkout: Path) -> None:
    result = run_local(local_checkout, BOTCUBE_PRODUCTION_ARTIFACTS='1')

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == [
        'compose', '-f', str(local_checkout / 'infra/local/compose.yml'),
        '-f', str(local_checkout / 'infra/local/compose.production.yml'),
        'up', '--build', '-d', 'harness',
    ]


@pytest.mark.parametrize('build_ca', ['readable', 'unset'])
def test_build_ca_reaches_compose_only_as_the_build_secret_overlay(local_checkout: Path, build_ca: str) -> None:
    bundle = local_checkout.parent / 'build-ca.pem'
    bundle.write_text('public fixture CA bundle')
    capture = local_checkout.parent / 'trust.log'

    result = run_local(
        local_checkout,
        BOTCUBE_BUILD_CA_CERTS=str(bundle) if build_ca == 'readable' else '',
        NODE_EXTRA_CA_CERTS='inherited-node-fixture.pem',
        SSL_CERT_FILE='inherited-ssl-fixture.pem',
        TRUST_CAPTURE=str(capture),
    )

    assert result.returncode == 0, result.stderr
    # Compose keeps the host's own trust settings; BuildKit mounts the bundle as a build secret.
    assert capture.read_text().splitlines() == ['inherited-node-fixture.pem|inherited-ssl-fixture.pem']
    overlay = ['-f', str(local_checkout / 'infra/local/compose.build-ca.yml')] if build_ca == 'readable' else []
    assert result.stdout.splitlines() == [
        'compose', '-f', str(local_checkout / 'infra/local/compose.yml'), *overlay,
        'up', '--build', '-d', 'harness',
    ]


def test_local_unreadable_build_ca_prevents_compose(local_checkout: Path) -> None:
    capture = local_checkout.parent / 'trust.log'

    result = run_local(
        local_checkout,
        BOTCUBE_BUILD_CA_CERTS=str(local_checkout.parent / 'missing-ca.pem'),
        TRUST_CAPTURE=str(capture),
    )

    assert result.returncode == 1
    assert result.stderr == 'BOTCUBE_BUILD_CA_CERTS must name a readable CA bundle\n'
    assert result.stdout == ''
    assert not capture.exists()


def test_compose_failure_is_the_entrypoints_failure(local_checkout: Path) -> None:
    (local_checkout.parent / 'bin/docker').write_text('#!/bin/sh\nexit 23\n')

    assert run_local(local_checkout).returncode == 23
