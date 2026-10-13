import os
import shutil
import subprocess
from pathlib import Path


def test_browser_staging_uses_the_staging_installation(tmp_path: Path) -> None:
    source = Path(__file__).resolve().parents[1]
    script = tmp_path / 'stage-browser-tools.mjs'
    shutil.copyfile(source / 'browser/install.mjs', script)
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


def test_browser_staging_missing_release_fails(tmp_path: Path) -> None:
    source = Path(__file__).resolve().parents[1]
    script = tmp_path / 'stage-browser-tools.mjs'
    shutil.copyfile(source / 'browser/install.mjs', script)

    result = subprocess.run(
        ['node', str(script), str(tmp_path)],
        capture_output=True, text=True, check=False,
    )

    assert result.returncode != 0
    assert 'ENOENT' in result.stderr
    assert not (tmp_path / 'agent-browser-linux-x64').exists()
    assert not (tmp_path / 'agent-browser-linux-arm64').exists()
