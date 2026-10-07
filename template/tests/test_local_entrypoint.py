import json
import os
import shutil
import subprocess
import tarfile
from pathlib import Path

import pytest


@pytest.fixture
def local_checkout(tmp_path: Path) -> Path:
    cube = tmp_path / 'botcube'
    source = Path(__file__).resolve().parents[2]
    for relative in ('infra/local/run.sh', 'template/deploy/stage-tools.sh'):
        destination = cube / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / relative, destination)
    deploy = cube / 'template/deploy'
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
        'docker': '''#!/bin/sh
set -eu
for artifact in bin/template-cli package.json cartridge/template.whl agent-browser-linux-x64 agent-browser-linux-arm64; do
  test -f "$LOCAL_CUBE/harness/deepagents/.tool-dist/$artifact" || exit 32
done
printf '%s\\n' "$@"
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


def run_local(cube: Path, **environment: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['bash', str(cube / 'infra/local/run.sh'), '-d', 'harness'],
        cwd=cube.parent,
        env={**os.environ, 'PATH': f'{cube.parent}/bin:{os.environ["PATH"]}', 'LOCAL_CUBE': str(cube), **environment},
        capture_output=True,
        text=True,
        check=False,
    )


def test_fresh_local_checkout_stages_tools_before_build(local_checkout: Path) -> None:
    result = run_local(local_checkout)

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == [
        'compose', '-f', str(local_checkout / 'infra/local/compose.yml'),
        'up', '--build', '-d', 'harness',
    ]


@pytest.mark.parametrize('symlinked', [False, True])
def test_local_staging_with_real_npm_through_symlink(local_checkout: Path, symlinked: bool) -> None:
    deploy = local_checkout / 'template/deploy'
    source = Path(__file__).resolve().parents[2]
    shutil.copyfile(source / 'template/deploy/stage-browser-tools.mjs', deploy / 'stage-browser-tools.mjs')
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

    result = run_local(
        cube, npm_config_cache=str(local_checkout.parent / 'npm-cache'),
        npm_config_offline='true', npm_config_audit='false', npm_config_fund='false',
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines()[-7:] == [
        'compose', '-f', str(cube / 'infra/local/compose.yml'),
        'up', '--build', '-d', 'harness',
    ]
    destination = local_checkout / 'harness/deepagents/.tool-dist'
    assert (destination / 'bin/template-cli').read_text() == 'cli'
    assert json.loads((destination / 'package.json').read_text()) == manifest
    assert (destination / 'cartridge/template.whl').read_text() == 'wheel'
    assert (destination / 'licenses/agent-browser/LICENSE').read_text() == 'fixture license'
    for name in ('LICENSE-axe-core.txt', 'LICENSE-axe-core-THIRD-PARTY.txt'):
        assert (destination / 'licenses/agent-browser' / name).read_text() == 'fixture notice'
    for architecture in ('x64', 'arm64'):
        browser = destination / f'agent-browser-linux-{architecture}'
        assert browser.read_bytes() == b'fixture browser'
        assert browser.stat().st_mode & 0o111 == 0o111
    assert not (destination / 'node_modules').exists()


def test_local_staging_failure_prevents_compose(local_checkout: Path) -> None:
    result = run_local(local_checkout, STAGING_FAILURE='uv')

    assert result.returncode == 27
    assert result.stdout == ''


@pytest.mark.parametrize('build_ca', ['readable', 'unset'])
def test_local_staging_trust_is_scoped_to_build_tools(local_checkout: Path, build_ca: str) -> None:
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
    if build_ca == 'readable':
        assert capture.read_text().splitlines() == [
            f'npm|{bundle}|{bundle}',
            f'uv|{bundle}|{bundle}',
            f'node|{bundle}|{bundle}',
            'docker|inherited-node-fixture.pem|inherited-ssl-fixture.pem',
        ]
        assert result.stdout.splitlines() == [
            'compose', '-f', str(local_checkout / 'infra/local/compose.yml'),
            '-f', str(local_checkout / 'infra/local/compose.build-ca.yml'),
            'up', '--build', '-d', 'harness',
        ]
    else:
        assert capture.read_text().splitlines() == [
            'npm|inherited-node-fixture.pem|inherited-ssl-fixture.pem',
            'uv|inherited-node-fixture.pem|inherited-ssl-fixture.pem',
            'node|inherited-node-fixture.pem|inherited-ssl-fixture.pem',
            'docker|inherited-node-fixture.pem|inherited-ssl-fixture.pem',
        ]


def test_local_unreadable_build_ca_prevents_staging_and_compose(local_checkout: Path) -> None:
    capture = local_checkout.parent / 'trust.log'

    result = run_local(
        local_checkout,
        BOTCUBE_BUILD_CA_CERTS=str(local_checkout.parent / 'missing-ca.pem'),
        NODE_EXTRA_CA_CERTS='inherited-node-fixture.pem',
        SSL_CERT_FILE='inherited-ssl-fixture.pem',
        TRUST_CAPTURE=str(capture),
    )

    assert result.returncode == 1
    assert result.stderr == 'BOTCUBE_BUILD_CA_CERTS must name a readable CA bundle\n'
    assert result.stdout == ''
    assert not capture.exists()
    assert not (local_checkout / 'harness/deepagents/.tool-dist').exists()


def test_browser_staging_uses_the_staging_installation(tmp_path: Path) -> None:
    source = Path(__file__).resolve().parents[2]
    script = tmp_path / 'stage-browser-tools.mjs'
    shutil.copyfile(source / 'template/deploy/stage-browser-tools.mjs', script)
    destination = tmp_path / 'tools'
    package = destination / 'node_modules/agent-browser'
    (package / 'bin').mkdir(parents=True)
    (destination / 'package.json').write_text('{}')
    (package / 'package.json').write_text('{"name":"agent-browser","version":"0.38.1"}')
    (package / 'LICENSE').write_text('fixture license')
    notices = package / 'cli/src/native/a11y'
    notices.mkdir(parents=True)
    for name in ('LICENSE-axe-core.txt', 'LICENSE-axe-core-THIRD-PARTY.txt'):
        (notices / name).write_text('fixture notice')
    for architecture in ('x64', 'arm64'):
        (package / f'bin/agent-browser-linux-{architecture}').write_bytes(b'fixture browser')

    result = subprocess.run(
        ['node', str(script), str(destination)],
        env={key: value for key, value in os.environ.items() if key != 'NODE_PATH'},
        capture_output=True, text=True, check=False,
    )

    assert result.returncode == 0, result.stderr
    assert (destination / 'licenses/agent-browser/LICENSE').read_text() == 'fixture license'
    for name in ('LICENSE-axe-core.txt', 'LICENSE-axe-core-THIRD-PARTY.txt'):
        assert (destination / 'licenses/agent-browser' / name).read_text() == 'fixture notice'
    for architecture in ('x64', 'arm64'):
        staged = destination / f'agent-browser-linux-{architecture}'
        assert staged.read_bytes() == b'fixture browser'
        assert staged.stat().st_mode & 0o111 == 0o111


def test_local_browser_install_failure_prevents_compose(local_checkout: Path) -> None:
    result = run_local(local_checkout, STAGING_FAILURE='npm')

    assert result.returncode == 28
    assert result.stdout == ''


def test_browser_staging_missing_release_fails(tmp_path: Path) -> None:
    source = Path(__file__).resolve().parents[2]
    script = tmp_path / 'stage-browser-tools.mjs'
    shutil.copyfile(source / 'template/deploy/stage-browser-tools.mjs', script)

    result = subprocess.run(
        ['node', str(script), str(tmp_path)],
        capture_output=True, text=True, check=False,
    )

    assert result.returncode != 0
    assert 'ENOENT' in result.stderr
    assert not (tmp_path / 'agent-browser-linux-x64').exists()
    assert not (tmp_path / 'agent-browser-linux-arm64').exists()


def test_local_corrupt_browser_release_prevents_compose(local_checkout: Path) -> None:
    deploy = local_checkout / 'template/deploy'
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

    result = run_local(
        local_checkout, npm_config_cache=str(local_checkout.parent / 'npm-cache'),
        npm_config_fetch_retries='0',
    )

    assert result.returncode != 0
    assert 'EINTEGRITY' in result.stderr
    assert 'compose' not in result.stdout
    assert not (local_checkout / 'harness/deepagents/.tool-dist/agent-browser-linux-x64').exists()
