from __future__ import annotations

import importlib.util
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

_SPEC = importlib.util.spec_from_file_location('migrate', Path(__file__).parents[1] / 'ecs/migrate_files.py')
assert _SPEC and _SPEC.loader
_MIGRATION = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MIGRATION)


@mock_aws
def test_copy_rechecks_counts_and_sha256_and_can_resume_without_changing_s3(tmp_path: Path) -> None:
    s3 = boto3.client('s3', region_name='us-east-1')
    s3.create_bucket(Bucket='migration-source')
    prefix = 'accounts/' + 'a' * 32
    s3.put_object(Bucket='migration-source', Key=f'{prefix}/one.txt', Body=b'one')
    s3.put_object(Bucket='migration-source', Key=f'{prefix}/sub/two.bin', Body=b'two')
    s3.put_object(Bucket='migration-source', Key=f'{prefix}/empty/', Body=b'')
    first = _MIGRATION.migrate(s3, 'migration-source', tmp_path)
    assert first['sourceCount'] == first['destinationCount'] == 3
    assert first['files'] == 2 and first['directories'] == 1
    assert (tmp_path / ('a' * 32) / 'empty').is_dir()
    assert first == _MIGRATION.migrate(s3, 'migration-source', tmp_path)
    assert (tmp_path / ('a' * 32) / 'sub/two.bin').read_bytes() == b'two'
    assert s3.get_object(Bucket='migration-source', Key=f'{prefix}/one.txt')['Body'].read() == b'one'
    (tmp_path / ('a' * 32) / 'one.txt').write_bytes(b'bad')
    with pytest.raises(ValueError, match='overwrite different'):
        _MIGRATION.migrate(s3, 'migration-source', tmp_path)


@mock_aws
def test_extra_destination_file_fails_the_count_check(tmp_path: Path) -> None:
    s3 = boto3.client('s3', region_name='us-east-1')
    s3.create_bucket(Bucket='migration-source')
    account = 'a' * 32
    s3.put_object(Bucket='migration-source', Key=f'accounts/{account}/one.txt', Body=b'one')
    (tmp_path / account).mkdir()
    (tmp_path / account / 'extra.txt').write_text('extra')
    with pytest.raises(ValueError, match='count or sha256'):
        _MIGRATION.migrate(s3, 'migration-source', tmp_path)


@mock_aws
def test_bucket_root_and_empty_account_markers_are_preserved(tmp_path: Path) -> None:
    s3 = boto3.client('s3', region_name='us-east-1')
    s3.create_bucket(Bucket='migration-source')
    account = 'b' * 32
    for key in ('accounts/', f'accounts/{account}/', f'accounts/{account}/empty/'):
        s3.put_object(Bucket='migration-source', Key=key, Body=b'')
    receipt = _MIGRATION.migrate(s3, 'migration-source', tmp_path)
    assert receipt['sourceCount'] == receipt['destinationCount'] == 3
    assert receipt['files'] == 0 and receipt['directories'] == 3
    assert receipt['accounts'][0]['count'] == 2
    assert (tmp_path / account / 'empty').is_dir()


def test_cli_refuses_an_unmounted_destination_before_copying(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import sys

    monkeypatch.setattr(sys, 'argv', ['migrate', '--bucket', 'source', '--accounts-root', str(tmp_path)])
    monkeypatch.setattr(_MIGRATION.boto3, 'client', lambda *_args: object())
    monkeypatch.setattr(_MIGRATION, 'migrate', lambda *_args: {})
    with pytest.raises(ValueError, match='accounts access point'):
        _MIGRATION.main()


@pytest.mark.parametrize('owner', [0, 65534])
def test_cli_refuses_root_or_root_squashed_mounts_before_copying(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, owner: int,
) -> None:
    import sys
    from types import SimpleNamespace

    original_stat = Path.stat
    monkeypatch.setattr(sys, 'argv', ['migrate', '--bucket', 'source', '--accounts-root', str(tmp_path)])
    monkeypatch.setattr(_MIGRATION.boto3, 'client', lambda *_args: object())
    monkeypatch.setattr(_MIGRATION, 'migrate', lambda *_args: {})
    monkeypatch.setattr(Path, 'is_mount', lambda self: self == tmp_path)
    monkeypatch.setattr(Path, 'stat', lambda self, **kwargs: SimpleNamespace(st_uid=owner, st_gid=owner) if self == tmp_path else original_stat(self, **kwargs))
    with pytest.raises(ValueError, match='1000'):
        _MIGRATION.main()


def test_cli_accepts_the_uid_1000_accounts_mount(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    import sys
    from types import SimpleNamespace

    original_stat = Path.stat
    copied = []
    monkeypatch.setattr(sys, 'argv', ['migrate', '--bucket', 'source', '--accounts-root', str(tmp_path)])
    monkeypatch.setattr(Path, 'is_mount', lambda self: self == tmp_path)
    monkeypatch.setattr(Path, 'stat', lambda self, **kwargs: SimpleNamespace(st_uid=1000, st_gid=1000) if self == tmp_path else original_stat(self, **kwargs))
    client = object()
    monkeypatch.setattr(_MIGRATION.boto3, 'client', lambda *_args: client)

    def copy(actual: object, bucket: str, root: Path) -> dict[str, int]:
        assert actual is client and bucket == 'source' and root == tmp_path
        copied.append(root)
        return {'sourceCount': 1, 'destinationCount': 1}

    monkeypatch.setattr(_MIGRATION, 'migrate', copy)
    _MIGRATION.main()
    assert copied == [tmp_path]
    assert 'destinationCount' in capsys.readouterr().out
