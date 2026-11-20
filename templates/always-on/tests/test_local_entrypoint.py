"""The template's tool-staging hook (deploy/stage-tools.sh), which the local stack's run.sh no longer calls."""

import json
import os
import shutil
import subprocess
import tarfile
from pathlib import Path

import pytest

# Runs a real subprocess, server or socket (ADR 0083 decision 1).
pytestmark = pytest.mark.integration

STAGED = ('bin/template-cli', 'package.json', 'cartridge/template.whl')


@pytest.fixture
def local_checkout(tmp_path: Path) -> Path:
    cube = tmp_path / 'botcube'
    source = Path(__file__).resolve().parents[3]
    relative = 'templates/always-on/deploy/stage-tools.sh'
    destination = cube / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source / relative, destination)
    deploy = cube / 'templates/always-on/deploy'
    (deploy / 'bin').mkdir()
    (deploy / 'bin/template-cli').write_text('cli')
    (deploy / 'tool-package.json').write_text('{}')
    (deploy / 'tool-package-lock.json').write_text('{}')
    doubles = tmp_path / 'bin'
    doubles.mkdir()
    commands = {
        'uv': '''#!/bin/sh
if [ "${STAGING_FAILURE:-}" = uv ]; then exit 27; fi
for argument do destination="$argument"; done
printf wheel > "$destination/template.whl"
''',
        'npm': '''#!/bin/sh
set -eu
if [ "${STAGING_FAILURE:-}" = npm ]; then exit 28; fi
test "$1" = ci
test "$2" = --ignore-scripts
test "$3" = --omit=dev
test "$4" = --prefix
for argument do destination="$argument"; done
test -f "$destination/package-lock.json"
mkdir -p "$destination/node_modules/agent-browser"
''',
        'node': '''#!/bin/sh
set -eu
test -f "$2/cartridge/template.whl"
test -d "$2/node_modules/agent-browser"
printf browser > "$2/agent-browser-linux-x64"
printf browser > "$2/agent-browser-linux-arm64"
''',
    }
    for name, content in commands.items():
        command = doubles / name
        capture = f'''if [ -n "${{TRUST_CAPTURE:-}}" ]; then
  printf '%s|%s|%s\\n' '{name}' "${{NODE_EXTRA_CA_CERTS:-}}" "${{SSL_CERT_FILE:-}}" >> "$TRUST_CAPTURE"
fi
'''
        command.write_text(content.replace('#!/bin/sh\n', '#!/bin/sh\n' + capture, 1))
        command.chmod(0o755)
    return cube


def stage_tools(cube: Path, **environment: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['bash', str(cube / 'templates/always-on/deploy/stage-tools.sh')],
        cwd=cube.parent,
        env={**os.environ, 'PATH': f'{cube.parent}/bin:{os.environ["PATH"]}', **environment},
        capture_output=True,
        text=True,
        check=False,
    )


def staged(cube: Path) -> list[str]:
    destination = cube / 'harness/deepagents/.tool-dist'
    return [artifact for artifact in STAGED if (destination / artifact).is_file()]


def test_fresh_local_checkout_stages_tools(local_checkout: Path) -> None:
    result = stage_tools(local_checkout)

    assert result.returncode == 0, result.stderr
    assert staged(local_checkout) == list(STAGED)


@pytest.mark.parametrize('symlinked', [False, True])
def test_local_staging_with_real_npm_through_symlink(local_checkout: Path, symlinked: bool) -> None:
    deploy = local_checkout / 'templates/always-on/deploy'
    release = local_checkout.parent / 'release'
    (release / 'bin').mkdir(parents=True)
    (release / 'package.json').write_text('{"name":"agent-browser","version":"0.38.1"}')
    (release / 'LICENSE').write_text('fixture license')
    notices = release / 'cli/src/native/a11y'
    notices.mkdir(parents=True)
    for name in ('LICENSE-axe-core.txt', 'LICENSE-axe-core-THIRD-PARTY.txt'):
        (notices / name).write_text('fixture notice')
    for architecture in ('x64', 'arm64'):
        (release / f'bin/agent-browser-linux-{architecture}').write_bytes(b'fixture browser')
    tarball = local_checkout.parent / 'release.tgz'
    with tarfile.open(tarball, 'w:gz') as archive:
        archive.add(release, arcname='package')
    manifest = {
        'name': 'botcube-tools', 'version': '0.1.0',
        'dependencies': {'agent-browser': tarball.as_uri()},
    }
    (deploy / 'tool-package.json').write_text(json.dumps(manifest))
    (deploy / 'tool-package-lock.json').write_text(json.dumps({
        'name': 'botcube-tools', 'version': '0.1.0', 'lockfileVersion': 3,
        'packages': {
            '': manifest,
            'node_modules/agent-browser': {'version': '0.38.1', 'resolved': tarball.as_uri()},
        },
    }))
    for command in ('npm', 'node'):
        (local_checkout.parent / 'bin' / command).unlink()
    cube = local_checkout
    if symlinked:
        alias = local_checkout.parent / 'ancestor'
        alias.symlink_to(local_checkout.parent, target_is_directory=True)
        cube = alias / local_checkout.name

    result = stage_tools(
        cube, npm_config_cache=str(local_checkout.parent / 'npm-cache'),
        npm_config_offline='true', npm_config_audit='false', npm_config_fund='false',
    )

    assert result.returncode == 0, result.stderr
    destination = local_checkout / 'harness/deepagents/.tool-dist'
    assert (destination / 'bin/template-cli').read_text() == 'cli'
    assert json.loads((destination / 'package.json').read_text()) == manifest
    assert (destination / 'cartridge/template.whl').read_text() == 'wheel'
    assert not (destination / 'node_modules').exists()


def test_local_staging_failure_stops_staging(local_checkout: Path) -> None:
    result = stage_tools(local_checkout, STAGING_FAILURE='uv')

    assert result.returncode == 27
    assert 'cartridge/template.whl' not in staged(local_checkout)


@pytest.mark.parametrize('trust', ['build-ca', 'inherited'])
def test_local_staging_uses_the_trust_its_caller_gives_its_build_tools(local_checkout: Path, trust: str) -> None:
    bundle = local_checkout.parent / 'build-ca.pem'
    bundle.write_text('public fixture CA bundle')
    capture = local_checkout.parent / 'trust.log'
    certificates = (str(bundle), str(bundle)) if trust == 'build-ca' else ('inherited-node-fixture.pem', 'inherited-ssl-fixture.pem')

    result = stage_tools(
        local_checkout,
        NODE_EXTRA_CA_CERTS=certificates[0],
        SSL_CERT_FILE=certificates[1],
        TRUST_CAPTURE=str(capture),
    )

    assert result.returncode == 0, result.stderr
    assert capture.read_text().splitlines() == [
        f'npm|{certificates[0]}|{certificates[1]}',
        f'uv|{certificates[0]}|{certificates[1]}',
    ]


def test_local_browser_install_failure_stops_staging(local_checkout: Path) -> None:
    result = stage_tools(local_checkout, STAGING_FAILURE='npm')

    assert result.returncode == 28
    assert 'cartridge/template.whl' not in staged(local_checkout)


def test_local_corrupt_browser_release_stops_staging(local_checkout: Path) -> None:
    deploy = local_checkout / 'templates/always-on/deploy'
    release = local_checkout.parent / 'release'
    release.mkdir()
    (release / 'package.json').write_text('{"name":"agent-browser","version":"0.38.1"}')
    tarball = local_checkout.parent / 'release.tgz'
    with tarfile.open(tarball, 'w:gz') as archive:
        archive.add(release, arcname='package')
    (deploy / 'tool-package.json').write_text(json.dumps({
        'name': 'test-tools', 'version': '1.0.0', 'dependencies': {'agent-browser': '0.38.1'},
    }))
    (deploy / 'tool-package-lock.json').write_text(json.dumps({
        'name': 'test-tools', 'version': '1.0.0', 'lockfileVersion': 3,
        'packages': {
            '': {'name': 'test-tools', 'version': '1.0.0', 'dependencies': {'agent-browser': '0.38.1'}},
            'node_modules/agent-browser': {
                'version': '0.38.1', 'resolved': tarball.as_uri(), 'integrity': f'sha512-{"A" * 86}==',
            },
        },
    }))
    for command in ('npm', 'node'):
        (local_checkout.parent / 'bin' / command).unlink()

    result = stage_tools(
        local_checkout, npm_config_cache=str(local_checkout.parent / 'npm-cache'),
        npm_config_fetch_retries='0',
    )

    assert result.returncode != 0
    assert 'EINTEGRITY' in result.stderr
    assert 'cartridge/template.whl' not in staged(local_checkout)
    assert not (local_checkout / 'harness/deepagents/.tool-dist/agent-browser-linux-x64').exists()
