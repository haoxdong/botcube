from __future__ import annotations

from pathlib import Path

import boto3
import pytest
from moto import mock_aws

from botcube_harness_deepagents.files_sync import RECORD_PATH, FilesSync, excluded_paths
from botcube_harness_deepagents.serving import _workspace


def test_new_workspace_child_supports_an_empty_s3_account(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    storage = tmp_path / 'session-storage'
    storage.mkdir()
    root = storage / 'files'
    monkeypatch.setenv('BOTCUBE_WORKSPACE', str(root))
    assert not root.exists()
    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='turn-files')
        files = FilesSync('turn-files', 'owner/', 'us-east-1',
                          {'accessKeyId': 'key', 'secretAccessKey': 'secret', 'sessionToken': 'token'})
        files.pull(_workspace(), excluded_paths(()))
        assert (root / RECORD_PATH).read_text() == '{}'
