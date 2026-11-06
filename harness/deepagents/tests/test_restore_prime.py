"""A restored Runtime V2 microVM keeps the snapshot's memory but reads its disk slowly the first time."""
import logging
import socket
import ssl
import subprocess
from collections.abc import Iterator, Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import boto3
import certifi
import pytest
from botocore.credentials import RefreshableCredentials
from botocore.exceptions import HTTPClientError

from botcube_harness_deepagents import aws_clients, restore_prime
from botcube_harness_deepagents.memory import agentcore


@pytest.fixture(autouse=True)
def environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    for variable in ('SSL_CERT_FILE', 'AWS_CA_BUNDLE', 'SSL_CERT_DIR'):
        monkeypatch.delenv(variable, raising=False)
    monkeypatch.setenv('AWS_ACCESS_KEY_ID', 'test')
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'test')
    aws_clients.bedrock.cache_clear()
    agentcore.sts_client.cache_clear()
    yield
    aws_clients.bedrock.cache_clear()
    agentcore.sts_client.cache_clear()


def test_the_ca_bundles_are_read_from_the_tmpfs_and_the_resolver_files_stay_on_disk(tmp_path: Path) -> None:
    root = tmp_path / 'restore'
    resolver = Path('/etc/resolv.conf')
    before = resolver.stat().st_ino if resolver.exists() else None

    restore_prime.hold_in_memory(root)

    paths = ssl.get_default_verify_paths()
    assert paths.cafile == str(root / 'ssl_cert_file.pem')
    source = paths.openssl_cafile if Path(paths.openssl_cafile).is_file() else certifi.where()
    assert Path(paths.cafile).read_bytes() == Path(source).read_bytes()
    # The bundle holds every root, so OpenSSL's by-hash directory lookups read nothing from the disk.
    assert paths.capath == str(root / 'certs')
    assert list(Path(paths.capath).iterdir()) == []
    assert Path(restore_prime.os.environ['AWS_CA_BUNDLE']).read_bytes() == Path(certifi.where()).read_bytes()
    assert (resolver.stat().st_ino if resolver.exists() else None) == before
    assert sorted(path.name for path in root.iterdir()) == ['aws_ca_bundle.pem', 'certs', 'ssl_cert_file.pem']


def test_only_the_images_resolver_configuration_is_bound_over_tmpfs_copies(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(restore_prime.os, 'geteuid', lambda: 0)
    mounts: list[list[str]] = []
    root = tmp_path / 'restore'
    root.mkdir()

    restore_prime.bind_static_resolver_config(root, lambda command: mounts.append(list(command)))

    present = [path for path in restore_prime.STATIC_RESOLVER_CONFIG if Path(path).is_file()]
    assert mounts == [['mount', '--bind', str(root / Path(path).name), path] for path in present]
    for path in present:
        assert (root / Path(path).name).read_bytes() == Path(path).read_bytes()
    # /etc/hosts and resolv.conf may differ between restores, so they stay the microVM's own.
    assert not {'/etc/hosts', '/etc/resolv.conf'} & {command[-1] for command in mounts}


def test_without_root_the_resolver_configuration_stays_on_disk_and_the_prime_goes_on(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(restore_prime.os, 'geteuid', lambda: 1000)
    mounts: list[Sequence[str]] = []

    with caplog.at_level(logging.WARNING, logger='botcube_harness_deepagents.restore_prime'):
        restore_prime.bind_static_resolver_config(tmp_path, mounts.append)

    assert mounts == []
    assert [record.getMessage() for record in caplog.records] == [
        'Restore prime left the resolver configuration on disk: the Harness does not run as root']


def test_a_bind_refused_to_root_fails_the_prime(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(restore_prime.os, 'geteuid', lambda: 0)
    config = tmp_path / 'nsswitch.conf'
    config.write_text('hosts: files dns\n')
    monkeypatch.setattr(restore_prime, 'STATIC_RESOLVER_CONFIG', (str(config),))
    (tmp_path / 'restore').mkdir()

    def refuse(command: Sequence[str]) -> None:
        raise subprocess.CalledProcessError(32, list(command), stderr=b'mount: permission denied')

    with pytest.raises(subprocess.CalledProcessError):
        restore_prime.bind_static_resolver_config(tmp_path / 'restore', refuse)


def test_a_python_whose_system_ca_bundle_is_missing_hands_openssl_the_certifi_bundle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    paths = ssl.get_default_verify_paths()
    monkeypatch.setattr(ssl, 'get_default_verify_paths', lambda: paths._replace(openssl_cafile=str(tmp_path / 'absent.pem')))

    restore_prime.hold_in_memory(tmp_path / 'restore')

    assert Path(restore_prime.os.environ['SSL_CERT_FILE']).read_bytes() == Path(certifi.where()).read_bytes()


def test_a_microvm_restored_after_the_runtime_credentials_expire_signs_with_fresh_ones(monkeypatch: pytest.MonkeyPatch) -> None:
    issued: list[str] = []

    def fetch() -> dict[str, Any]:
        issued.append(f'key-{len(issued)}')
        return {'access_key': issued[-1], 'secret_key': 's', 'token': 't',
                'expiry_time': (datetime.now(UTC) + timedelta(hours=1)).isoformat()}

    credentials = RefreshableCredentials.create_from_metadata(fetch(), fetch, 'container-role')
    session = boto3.Session()
    monkeypatch.setattr(session._session, '_credentials', credentials)
    monkeypatch.setattr(boto3, 'DEFAULT_SESSION', session)

    restore_prime.runtime_credentials('us-east-1')
    # The snapshot is restored after the credentials it holds expired.
    monkeypatch.setattr(credentials, '_expiry_time', datetime.now(UTC) - timedelta(minutes=1))

    held = boto3._get_default_session().get_credentials()
    assert held is not None
    assert held.get_frozen_credentials().access_key == 'key-1'
    assert issued == ['key-0', 'key-1']


def test_the_sdk_request_paths_are_primed_without_the_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*_: Any, **__: Any) -> None:
        raise AssertionError('the snapshot build must not send these requests')
    monkeypatch.setattr(socket.socket, 'connect', forbidden)
    monkeypatch.setattr(socket, 'getaddrinfo', forbidden)

    restore_prime.answer_sdk_calls('us-east-1')

    # A Turn's exchange afterwards goes to STS, not to the prime's answer.
    with pytest.raises(HTTPClientError, match='must not send'):
        agentcore.sts_client('us-east-1').assume_role_with_web_identity(
            RoleArn='arn:aws:iam::000000000000:role/turn', RoleSessionName='turn', WebIdentityToken='turn' * 4)
