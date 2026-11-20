from __future__ import annotations

from pathlib import Path

import pytest

from botcube_harness_deepagents.credential_source import (
    Credential,
    CredentialSourceError,
    credential_source,
)

START = 1_795_000_000.0


def test_gives_the_mounted_files_contents_without_its_trailing_newline_until_five_minutes_on(tmp_path: Path) -> None:
    path = tmp_path / 'models-api-key'
    path.write_text('sk-mounted\n')

    source = credential_source('models', {'kind': 'file', 'path': str(path)}, now=lambda: START)

    assert source.get() == Credential(value='sk-mounted', expires_at=START + 300)


def test_reads_the_file_again_a_minute_before_its_value_expires(tmp_path: Path) -> None:
    path = tmp_path / 'models-api-key'
    path.write_text('sk-first')
    clock = [START]
    source = credential_source('models', {'kind': 'file', 'path': str(path)}, now=lambda: clock[0])
    source.get()
    path.write_text('sk-rotated')

    clock[0] = START + 120
    assert source.get().value == 'sk-first'
    clock[0] = START + 241
    assert source.get().value == 'sk-rotated'


def test_fails_naming_its_seam_and_its_file(tmp_path: Path) -> None:
    path = tmp_path / 'absent'
    with pytest.raises(CredentialSourceError, match=f'^models credential \\(file {path}\\): .*No such file'):
        credential_source('models', {'kind': 'file', 'path': str(path)}).get()


def test_fails_on_an_empty_file(tmp_path: Path) -> None:
    path = tmp_path / 'empty'
    path.write_text('\n')
    with pytest.raises(CredentialSourceError, match=f'^models credential \\(file {path}\\): the file is empty$'):
        credential_source('models', {'kind': 'file', 'path': str(path)}).get()


@pytest.mark.parametrize(('source', 'issue'), [
    ({'kind': 'file'}, 'file.path'),
    ({'kind': 'file', 'path': '/run/secrets/models', 'mode': 'raw'}, 'file.mode'),
    ({'kind': 'vault', 'path': '/run/secrets/models'}, 'kind'),
])
def test_refuses_a_malformed_source_naming_its_seam_and_the_field(source: dict[str, str], issue: str) -> None:
    with pytest.raises(CredentialSourceError, match=rf'^models credential: {issue}: '):
        credential_source('models', source)
