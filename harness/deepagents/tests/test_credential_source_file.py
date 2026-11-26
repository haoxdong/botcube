from __future__ import annotations

from pathlib import Path

import pytest
from botcube_credential_source import (
    Credential,
    CredentialSourceError,
    credential_source,
)


def test_reads_the_current_file_on_each_get_and_removes_its_trailing_newline(tmp_path: Path) -> None:
    path = tmp_path / 'models-api-key'
    path.write_text('sk-mounted\n')
    source = credential_source('models', {'kind': 'file', 'path': str(path)})

    assert source.get().value == 'sk-mounted'
    path.write_text('sk-rotated\n')
    assert source.get() == Credential(value='sk-rotated', expires_at=None)


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
