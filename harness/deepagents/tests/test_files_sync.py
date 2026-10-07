from __future__ import annotations

import os
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

from botcube_harness_deepagents.files_sync import FilesSync, excluded_paths


def test_unchanged_synced_file_stays_deleted_despite_a_newer_local_timestamp_issue_3492(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='turn-files')
        s3.put_object(Bucket='turn-files', Key='owner/report.csv', Body=b'date,close')
        monkeypatch.setattr(FilesSync, '_client', lambda self: s3)
        files = FilesSync('turn-files', 'owner/', 'us-east-1', {})
        excluded = excluded_paths(())
        files.pull(tmp_path, excluded)
        report = tmp_path / 'report.csv'
        stamp = report.stat().st_mtime
        os.utime(report, (stamp + 0.5, stamp + 0.5))
        s3.delete_object(Bucket='turn-files', Key='owner/report.csv')

        files.push(tmp_path, excluded)

        assert report.read_bytes() == b'date,close'
        assert s3.list_objects_v2(Bucket='turn-files').get('Contents', []) == []

        files.pull(tmp_path, excluded)

        assert not report.exists()


@pytest.mark.parametrize('timestamp_offset', [0, -10])
def test_changed_synced_bytes_upload_even_without_a_newer_timestamp(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, timestamp_offset: int,
) -> None:
    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='turn-files')
        s3.put_object(Bucket='turn-files', Key='owner/report.csv', Body=b'date,close')
        monkeypatch.setattr(FilesSync, '_client', lambda self: s3)
        files = FilesSync('turn-files', 'owner/', 'us-east-1', {})
        excluded = excluded_paths(())
        files.pull(tmp_path, excluded)
        report = tmp_path / 'report.csv'
        stamp = report.stat().st_mtime + timestamp_offset
        report.write_bytes(b'date,adjusted_close')
        os.utime(report, (stamp, stamp))

        files.push(tmp_path, excluded)

        assert s3.get_object(Bucket='turn-files', Key='owner/report.csv')['Body'].read() == b'date,adjusted_close'


def test_unchanged_synced_bytes_add_no_s3_versions_even_after_an_upload(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='turn-files')
        s3.put_bucket_versioning(Bucket='turn-files', VersioningConfiguration={'Status': 'Enabled'})
        original = s3.put_object(Bucket='turn-files', Key='owner/report.csv', Body=b'date,close')['VersionId']
        monkeypatch.setattr(FilesSync, '_client', lambda self: s3)
        files = FilesSync('turn-files', 'owner/', 'us-east-1', {})
        excluded = excluded_paths(())
        files.pull(tmp_path, excluded)
        report = tmp_path / 'report.csv'
        stamp = report.stat().st_mtime + 10
        os.utime(report, (stamp, stamp))

        files.push(tmp_path, excluded)

        assert s3.get_object(Bucket='turn-files', Key='owner/report.csv')['Body'].read() == b'date,close'
        assert [version['VersionId'] for version in s3.list_object_versions(Bucket='turn-files')['Versions']] == [original]

        report.write_bytes(b'date,adjusted_close')
        files.push(tmp_path, excluded)
        uploaded = s3.head_object(Bucket='turn-files', Key='owner/report.csv')['VersionId']
        os.utime(report, (stamp, stamp))

        files.push(tmp_path, excluded)

        assert s3.get_object(Bucket='turn-files', Key='owner/report.csv')['Body'].read() == b'date,adjusted_close'
        assert [version['VersionId'] for version in s3.list_object_versions(Bucket='turn-files')['Versions']] == [uploaded, original]


def test_unchanged_synced_file_stays_deleted_after_a_turn_stops_before_push_issue_3492(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='turn-files')
        s3.put_object(Bucket='turn-files', Key='owner/report.csv', Body=b'date,close')
        monkeypatch.setattr(FilesSync, '_client', lambda self: s3)
        excluded = excluded_paths(())
        FilesSync('turn-files', 'owner/', 'us-east-1', {}).pull(tmp_path, excluded)
        report = tmp_path / 'report.csv'
        stamp = report.stat().st_mtime
        os.utime(report, (stamp + 0.5, stamp + 0.5))
        s3.delete_object(Bucket='turn-files', Key='owner/report.csv')

        next_turn = FilesSync('turn-files', 'owner/', 'us-east-1', {})
        next_turn.pull(tmp_path, excluded)
        next_turn.push(tmp_path, excluded)

        assert not report.exists()
        assert s3.list_objects_v2(Bucket='turn-files').get('Contents', []) == []


def test_touch_across_stopped_turns_stays_deleted(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='turn-files')
        s3.put_object(Bucket='turn-files', Key='owner/report.csv', Body=b'date,close')
        monkeypatch.setattr(FilesSync, '_client', lambda self: s3)
        excluded = excluded_paths(())
        FilesSync('turn-files', 'owner/', 'us-east-1', {}).pull(tmp_path, excluded)
        report = tmp_path / 'report.csv'
        stamp = report.stat().st_mtime + 10
        os.utime(report, (stamp, stamp))
        next_turn = FilesSync('turn-files', 'owner/', 'us-east-1', {})
        next_turn.pull(tmp_path, excluded)
        s3.delete_object(Bucket='turn-files', Key='owner/report.csv')
        next_turn.push(tmp_path, excluded)
        assert report.read_bytes() == b'date,close'
        assert s3.list_objects_v2(Bucket='turn-files').get('Contents', []) == []
        FilesSync('turn-files', 'owner/', 'us-east-1', {}).pull(tmp_path, excluded)
        assert not report.exists()


def test_pending_edit_survives_stopped_turns_and_deletion(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='turn-files')
        s3.put_object(Bucket='turn-files', Key='owner/report.csv', Body=b'date,close')
        monkeypatch.setattr(FilesSync, '_client', lambda self: s3)
        excluded = excluded_paths(())
        FilesSync('turn-files', 'owner/', 'us-east-1', {}).pull(tmp_path, excluded)
        report = tmp_path / 'report.csv'
        stamp = report.stat().st_mtime
        report.write_bytes(b'date,adjusted_close')
        os.utime(report, (stamp + 10, stamp + 10))
        FilesSync('turn-files', 'owner/', 'us-east-1', {}).pull(tmp_path, excluded)
        assert report.read_bytes() == b'date,adjusted_close'
        s3.delete_object(Bucket='turn-files', Key='owner/report.csv')
        FilesSync('turn-files', 'owner/', 'us-east-1', {}).pull(tmp_path, excluded)
        os.utime(report, (stamp - 10, stamp - 10))
        files = FilesSync('turn-files', 'owner/', 'us-east-1', {})
        files.pull(tmp_path, excluded)
        files.push(tmp_path, excluded)
        assert s3.get_object(Bucket='turn-files', Key='owner/report.csv')['Body'].read() == b'date,adjusted_close'


def test_legacy_record_migrates_after_download(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import json

    from botcube_harness_deepagents.files_sync import RECORD_PATH

    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='turn-files')
        s3.put_object(Bucket='turn-files', Key='owner/report.csv', Body=b'date,close')
        monkeypatch.setattr(FilesSync, '_client', lambda self: s3)
        record = tmp_path / RECORD_PATH
        record.parent.mkdir()
        record.write_text('{"report.csv": 0}')
        FilesSync('turn-files', 'owner/', 'us-east-1', {}).pull(tmp_path, excluded_paths(()))
        assert (tmp_path / 'report.csv').read_bytes() == b'date,close'
        assert json.loads(record.read_text())['report.csv']['digest'] == 'd857acfa2c9e6a097ace214bc69ac7a8ed10c6d83afda1dc150ce96b976c0bf2'


@pytest.mark.parametrize('value', [
    {'stamp': 1, 'digest': 'invalid'},
    {'stamp': True, 'digest': 'a' * 64},
    {'stamp': 1, 'digest': None},
])
def test_malformed_baseline_fails_classified(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, value: object,
) -> None:
    import json

    from botcube_harness_deepagents.files_sync import RECORD_PATH, FilesSyncRecordError

    record = tmp_path / RECORD_PATH
    record.parent.mkdir()
    record.write_text(json.dumps({'report.csv': value}))
    monkeypatch.setattr(FilesSync, '_client', lambda self: None)
    files = FilesSync('turn-files', 'owner/', 'us-east-1', {})
    with pytest.raises(FilesSyncRecordError, match='invalid file stamp or SHA256 digest') as failure:
        files.pull(tmp_path, excluded_paths(()))
    assert failure.value.code == 'FILES_SYNC_RECORD'


def test_recreated_file_with_identical_bytes_uploads_after_both_copies_were_deleted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='turn-files')
        s3.put_object(Bucket='turn-files', Key='owner/report.csv', Body=b'date,close')
        monkeypatch.setattr(FilesSync, '_client', lambda self: s3)
        excluded = excluded_paths(())
        FilesSync('turn-files', 'owner/', 'us-east-1', {}).pull(tmp_path, excluded)
        report = tmp_path / 'report.csv'
        report.unlink()
        s3.delete_object(Bucket='turn-files', Key='owner/report.csv')
        next_turn = FilesSync('turn-files', 'owner/', 'us-east-1', {})
        next_turn.pull(tmp_path, excluded)
        report.write_bytes(b'date,close')

        next_turn.push(tmp_path, excluded)

        assert s3.get_object(Bucket='turn-files', Key='owner/report.csv')['Body'].read() == b'date,close'
        FilesSync('turn-files', 'owner/', 'us-east-1', {}).pull(tmp_path, excluded)
        assert report.read_bytes() == b'date,close'


@pytest.mark.parametrize('interrupted', [False, True])
def test_legacy_unchanged_file_stays_deleted_after_newer_timestamp(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, interrupted: bool,
) -> None:
    import json

    from botcube_harness_deepagents.files_sync import RECORD_PATH

    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='turn-files')
        s3.put_object(Bucket='turn-files', Key='owner/report.csv', Body=b'date,close')
        monkeypatch.setattr(FilesSync, '_client', lambda self: s3)
        files = FilesSync('turn-files', 'owner/', 'us-east-1', {})
        excluded = excluded_paths(())
        files.pull(tmp_path, excluded)
        report = tmp_path / 'report.csv'
        stamp = int(report.stat().st_mtime)
        (tmp_path / RECORD_PATH).write_text(json.dumps({'report.csv': stamp}))
        os.utime(report, (stamp + 10, stamp + 10))
        files.pull(tmp_path, excluded)
        s3.delete_object(Bucket='turn-files', Key='owner/report.csv')
        if interrupted:
            FilesSync('turn-files', 'owner/', 'us-east-1', {}).pull(tmp_path, excluded)

        files.push(tmp_path, excluded)

        assert s3.list_objects_v2(Bucket='turn-files').get('Contents', []) == []
        files.pull(tmp_path, excluded)
        assert not report.exists()


def test_legacy_dirty_file_survives_migration_and_remote_deletion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import json

    from botcube_harness_deepagents.files_sync import RECORD_PATH

    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='turn-files')
        s3.put_object(Bucket='turn-files', Key='owner/report.csv', Body=b'date,close')
        monkeypatch.setattr(FilesSync, '_client', lambda self: s3)
        files = FilesSync('turn-files', 'owner/', 'us-east-1', {})
        excluded = excluded_paths(())
        files.pull(tmp_path, excluded)
        report = tmp_path / 'report.csv'
        stamp = int(report.stat().st_mtime)
        (tmp_path / RECORD_PATH).write_text(json.dumps({'report.csv': stamp}))
        report.write_bytes(b'date,adjusted_close')
        os.utime(report, (stamp + 10, stamp + 10))

        files.pull(tmp_path, excluded)

        assert report.read_bytes() == b'date,adjusted_close'
        s3.delete_object(Bucket='turn-files', Key='owner/report.csv')
        files.pull(tmp_path, excluded)
        files.push(tmp_path, excluded)
        assert s3.get_object(Bucket='turn-files', Key='owner/report.csv')['Body'].read() == b'date,adjusted_close'


def test_legacy_migration_download_failure_preserves_local_edit_and_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import json

    from botcube_harness_deepagents.files_sync import RECORD_PATH

    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='turn-files')
        s3.put_object(Bucket='turn-files', Key='owner/report.csv', Body=b'date,close')
        monkeypatch.setattr(FilesSync, '_client', lambda self: s3)
        files = FilesSync('turn-files', 'owner/', 'us-east-1', {})
        excluded = excluded_paths(())
        files.pull(tmp_path, excluded)
        report = tmp_path / 'report.csv'
        stamp = int(report.stat().st_mtime)
        legacy = json.dumps({'report.csv': stamp})
        record = tmp_path / RECORD_PATH
        record.write_text(legacy)
        report.write_bytes(b'date,adjusted_close')
        os.utime(report, (stamp + 10, stamp + 10))
        failure = OSError('migration download failed')

        def fail_download(*args: object, **kwargs: object) -> None:
            raise failure

        monkeypatch.setattr(s3, 'download_file', fail_download)

        with pytest.raises(OSError, match='migration download failed') as caught:
            files.pull(tmp_path, excluded)

        assert caught.value is failure
        assert report.read_bytes() == b'date,adjusted_close'
        assert record.read_text() == legacy
