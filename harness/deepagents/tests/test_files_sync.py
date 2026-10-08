from __future__ import annotations

import os
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

from botcube_harness_deepagents.files_sync import FilesSync, excluded_paths


@pytest.mark.parametrize('condition', ['missing-etag', 'missing-local', 'other-prefix'])
def test_warm_files_only_reuse_verified_bytes_from_the_same_listed_object(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, condition: str,
) -> None:
    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='turn-files')
        s3.put_object(Bucket='turn-files', Key='owner/report.csv', Body=b'date,close')
        monkeypatch.setattr(FilesSync, '_client', lambda self: s3)
        files = FilesSync('turn-files', 'owner/', 'us-east-1', {})
        files.pull(tmp_path, excluded_paths(()))
        downloads: list[str] = []
        get = s3.get_object

        def downloaded(**kwargs: object) -> object:
            downloads.append(str(kwargs['Key']))
            return get(**kwargs)

        monkeypatch.setattr(s3, 'get_object', downloaded)
        if condition == 'missing-local':
            (tmp_path / 'report.csv').unlink()
        elif condition == 'other-prefix':
            s3.put_object(Bucket='turn-files', Key='other/report.csv', Body=b'date,close')
            files = FilesSync('turn-files', 'other/', 'us-east-1', {})
        else:
            listing = s3.list_objects_v2

            def without_etag(**kwargs: object) -> object:
                result = listing(**kwargs)
                for item in result.get('Contents', []):
                    item.pop('ETag', None)
                return result

            monkeypatch.setattr(s3, 'list_objects_v2', without_etag)

        files.pull(tmp_path, excluded_paths(()))

        assert (tmp_path / 'report.csv').read_bytes() == b'date,close'
        assert downloads == [f'{files.prefix}report.csv']


def test_warm_files_reuse_a_multipart_object_without_treating_its_etag_as_a_content_hash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='turn-files')
        upload = s3.create_multipart_upload(Bucket='turn-files', Key='owner/large.bin')['UploadId']
        parts = []
        for number, body in enumerate((b'a' * (5 * 1024 * 1024), b'b' * (5 * 1024 * 1024)), 1):
            part = s3.upload_part(Bucket='turn-files', Key='owner/large.bin', UploadId=upload,
                                 PartNumber=number, Body=body)
            parts.append({'PartNumber': number, 'ETag': part['ETag']})
        completed = s3.complete_multipart_upload(Bucket='turn-files', Key='owner/large.bin', UploadId=upload,
                                                MultipartUpload={'Parts': parts})
        assert completed['ETag'].endswith('-2"')
        monkeypatch.setattr(FilesSync, '_client', lambda self: s3)
        files = FilesSync('turn-files', 'owner/', 'us-east-1', {})
        files.pull(tmp_path, excluded_paths(()))

        def no_second_download(**kwargs: object) -> object:
            raise AssertionError('unchanged multipart object downloaded again')

        monkeypatch.setattr(s3, 'get_object', no_second_download)
        files.pull(tmp_path, excluded_paths(()))

        assert (tmp_path / 'large.bin').read_bytes() == b'a' * (5 * 1024 * 1024) + b'b' * (5 * 1024 * 1024)


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
    {'stamp': 1, 'digest': 'a' * 64, 'remote': None},
    {'stamp': 1, 'digest': 'a' * 64, 'remote': ''},
    {'stamp': 1, 'digest': 'a' * 64, 'remote': 1},
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

        monkeypatch.setattr('botcube_harness_deepagents.files_sync._download_file', fail_download)

        with pytest.raises(OSError, match='migration download failed') as caught:
            files.pull(tmp_path, excluded)

        assert caught.value is failure
        assert report.read_bytes() == b'date,adjusted_close'
        assert record.read_text() == legacy


def test_files_pull_overlaps_downloads_with_four_worker_bound_issue_3701(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import hashlib
    import json
    import threading
    from datetime import UTC, datetime

    from botcube_harness_deepagents.files_sync import RECORD_PATH

    rendezvous = threading.Barrier(4, timeout=5)
    lock = threading.Lock()
    active = 0
    maximum = 0
    completed: list[str] = []

    class FilesClient:
        def get_paginator(self, operation: str) -> FilesClient:
            assert operation == 'list_objects_v2'
            return self

        def paginate(self, **kwargs: object) -> list[dict[str, object]]:
            return [{'Contents': [
                {'Key': f'owner/file-{index}.txt', 'LastModified': datetime(2026, 10, 1, tzinfo=UTC)}
                for index in range(8)
            ]}]

        def download_file(self, bucket: str, key: str, destination: str) -> None:
            nonlocal active, maximum
            with lock:
                active += 1
                maximum = max(maximum, active)
            try:
                rendezvous.wait()
                Path(destination).write_bytes(key.encode())
                with lock:
                    completed.append(key)
            finally:
                with lock:
                    active -= 1

    monkeypatch.setattr(FilesSync, '_client', lambda self: FilesClient())
    monkeypatch.setattr('botcube_harness_deepagents.files_sync._download_file',
                        lambda s3, bucket, key, destination: s3.download_file(bucket, key, str(destination)))
    FilesSync('turn-files', 'owner/', 'us-east-1', {}).pull(tmp_path, excluded_paths(()))

    assert maximum == 4
    assert len(completed) == 8
    for index in range(8):
        assert (tmp_path / f'file-{index}.txt').read_bytes() == f'owner/file-{index}.txt'.encode()
    record = json.loads((tmp_path / RECORD_PATH).read_text())
    assert len(record) == 8
    for index in range(8):
        assert record[f'file-{index}.txt']['digest'] == hashlib.sha256(f'owner/file-{index}.txt'.encode()).hexdigest()


def test_files_pull_failure_waits_for_downloads_without_publishing_record_issue_3701(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import threading
    from datetime import UTC, datetime

    from botcube_harness_deepagents.files_sync import RECORD_PATH

    started = threading.Event()
    failed = threading.Event()
    completed = threading.Event()
    failure = OSError('Files download failed')
    record = tmp_path / RECORD_PATH
    record.parent.mkdir()
    record.write_text('{}')

    def keep_download_in_flight() -> None:
        assert failed.wait(5), 'sibling download never failed'
        threading.Event().wait(0.05)

    class FilesClient:
        def get_paginator(self, operation: str) -> FilesClient:
            return self

        def paginate(self, **kwargs: object) -> list[dict[str, object]]:
            return [{'Contents': [
                {'Key': f'owner/{name}.txt', 'LastModified': datetime(2026, 10, 1, tzinfo=UTC)}
                for name in ('failed', 'successful')
            ]}]

        def download_file(self, bucket: str, key: str, destination: str) -> None:
            if key == 'owner/failed.txt':
                assert started.wait(5), 'independent download never started'
                failed.set()
                raise failure
            started.set()
            keep_download_in_flight()
            Path(destination).write_bytes(b'successful')
            completed.set()

    monkeypatch.setattr(FilesSync, '_client', lambda self: FilesClient())
    monkeypatch.setattr('botcube_harness_deepagents.files_sync._download_file',
                        lambda s3, bucket, key, destination: s3.download_file(bucket, key, str(destination)))
    with pytest.raises(OSError, match='Files download failed') as caught:
        FilesSync('turn-files', 'owner/', 'us-east-1', {}).pull(tmp_path, excluded_paths(()))

    assert caught.value is failure
    assert completed.is_set()
    assert (tmp_path / 'successful.txt').read_bytes() == b'successful'
    assert record.read_text() == '{}'


def test_files_pull_preserves_first_rejected_failure_issue_3701(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import threading
    from collections.abc import Callable
    from concurrent.futures import Future, ThreadPoolExecutor, wait
    from datetime import UTC, datetime
    from typing import Any

    from botcube_harness_deepagents import files_sync

    rejected = threading.Event()
    first_failure = OSError('later-listed download rejected first')
    later_failure = OSError('earlier-listed download rejected later')

    class ObservedDownloads(ThreadPoolExecutor):
        def submit(self, fn: Any, /, *args: Any, **kwargs: Any) -> Future[Any]:
            future = super().submit(fn, *args, **kwargs)
            if args[2] == 'owner/second.txt':
                wait([future], timeout=5)
                assert future.done()
                register = future.add_done_callback

                def observe(callback: Callable[[Future[Any]], object]) -> None:
                    def settled(done: Future[Any]) -> None:
                        callback(done)
                        rejected.set()
                    register(settled)

                monkeypatch.setattr(future, 'add_done_callback', observe)
            return future

    class FilesClient:
        def get_paginator(self, operation: str) -> FilesClient:
            return self

        def paginate(self, **kwargs: object) -> list[dict[str, object]]:
            return [{'Contents': [
                {'Key': f'owner/{name}.txt', 'LastModified': datetime(2026, 10, 1, tzinfo=UTC)}
                for name in ('first', 'second')
            ]}]

        def download_file(self, bucket: str, key: str, destination: str) -> None:
            if key == 'owner/first.txt':
                assert rejected.wait(5), 'first rejection never settled'
                raise later_failure
            raise first_failure

    monkeypatch.setattr(files_sync, 'ThreadPoolExecutor', ObservedDownloads)
    monkeypatch.setattr(FilesSync, '_client', lambda self: FilesClient())
    monkeypatch.setattr('botcube_harness_deepagents.files_sync._download_file',
                        lambda s3, bucket, key, destination: s3.download_file(bucket, key, str(destination)))
    with pytest.raises(OSError) as caught:
        FilesSync('turn-files', 'owner/', 'us-east-1', {}).pull(tmp_path, excluded_paths(()))

    assert caught.value is first_failure


def test_files_pull_cancels_queued_downloads_and_joins_started_workers_issue_3701(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import threading
    from concurrent.futures import Future, ThreadPoolExecutor
    from datetime import UTC, datetime
    from typing import Any

    from botcube_harness_deepagents import files_sync

    release = threading.Event()
    initial_workers = threading.Barrier(4, timeout=5)
    lock = threading.Lock()
    started: list[str] = []
    started_jobs: list[str] = []
    finished: list[str] = []
    started_at_shutdown: list[str] = []
    failure = OSError('Files outage')

    class ObservedDownloads(ThreadPoolExecutor):
        def submit(self, fn: Any, /, *args: Any, **kwargs: Any) -> Future[Any]:
            def work() -> Any:
                with lock:
                    started_jobs.append(args[2])
                return fn(*args, **kwargs)
            return super().submit(work)

        def shutdown(self, wait: bool = True, *, cancel_futures: bool = False) -> None:
            with lock:
                started_at_shutdown.extend(started_jobs)
            release.set()
            super().shutdown(wait=wait, cancel_futures=cancel_futures)

    class FilesClient:
        def get_paginator(self, operation: str) -> FilesClient:
            return self

        def paginate(self, **kwargs: object) -> list[dict[str, object]]:
            return [{'Contents': [
                {'Key': f'owner/file-{index}.txt', 'LastModified': datetime(2026, 10, 1, tzinfo=UTC)}
                for index in range(20)
            ]}]

        def download_file(self, bucket: str, key: str, destination: str) -> None:
            with lock:
                started.append(key)
            if key in {f'owner/file-{index}.txt' for index in range(4)}:
                initial_workers.wait()
            if key == 'owner/file-0.txt':
                raise failure
            assert release.wait(5), 'executor never began settling its workers'
            Path(destination).write_bytes(key.encode())
            with lock:
                finished.append(key)

    monkeypatch.setattr(files_sync, 'ThreadPoolExecutor', ObservedDownloads)
    monkeypatch.setattr(FilesSync, '_client', lambda self: FilesClient())
    monkeypatch.setattr('botcube_harness_deepagents.files_sync._download_file',
                        lambda s3, bucket, key, destination: s3.download_file(bucket, key, str(destination)))
    with pytest.raises(OSError) as caught:
        FilesSync('turn-files', 'owner/', 'us-east-1', {}).pull(tmp_path, excluded_paths(()))

    assert caught.value is failure
    assert len(started) < 20
    assert sorted(started) == sorted(started_at_shutdown)
    assert sorted(finished) == sorted(key for key in started if key != 'owner/file-0.txt')
    assert not (tmp_path / files_sync.RECORD_PATH).exists()
