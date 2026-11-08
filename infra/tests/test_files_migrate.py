from __future__ import annotations

import importlib.util
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

_SPEC = importlib.util.spec_from_file_location('migrate', Path(__file__).parents[1] / 'ecs/files/migrate.py')
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
