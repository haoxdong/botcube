"""Before a Runtime V2 snapshot, what a restored microVM's first request would otherwise read from its disk or fetch.

A restored microVM keeps the snapshot's process memory but reads its root disk slowly the first time, and the page
cache does not survive: a 222 KB CA bundle took 1.5-3 s, and OpenSSL's CA directory lookups added ~1.2 s to the first
TLS handshake. /dev/shm is a tmpfs, memory, so the snapshot keeps what the prime copies there. The runtime role's credentials and
the STS and S3 request paths are prepared too, and the Memory client is built before any Turn names its sandbox.
Nothing per user is fetched: the Turn's identity, Memory credentials and Files binding arrive with the Turn.
"""
from __future__ import annotations

import logging
import os
import shutil
import ssl
import subprocess
from collections.abc import Callable, Iterator, Sequence
from pathlib import Path
from typing import Any

import boto3
import certifi
from botocore.awsrequest import AWSResponse
from botocore.compat import HTTPHeaders

from . import aws_clients
from .memory import agentcore as agentcore_memory_backend

log = logging.getLogger(__name__)

ROOT = Path('/dev/shm/botcube-restore')
# glibc reads these on every lookup. They come with the image, so a copy cannot go stale; /etc/hosts and resolv.conf
# can differ between restores and stay on disk.
STATIC_RESOLVER_CONFIG = ('/etc/nsswitch.conf', '/etc/host.conf', '/etc/gai.conf')
_STS_ANSWER = (
    b'<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">'
    b'<AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>A</AccessKeyId><SecretAccessKey>S</SecretAccessKey>'
    b'<SessionToken>T</SessionToken><Expiration>2030-01-01T00:00:00Z</Expiration></Credentials>'
    b'</AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>'
)
_S3_ANSWER = (
    b'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name><Prefix>p/</Prefix>'
    b'<KeyCount>1</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated><Contents><Key>p/a.txt</Key>'
    b'<LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>"e"</ETag><Size>1</Size></Contents></ListBucketResult>'
)


def run(command: Sequence[str]) -> None:
    subprocess.run(list(command), check=True, capture_output=True)


def prime_if_enabled(region: str, memory_id: str) -> None:
    """Runtime V2 only (BOTCUBE_RESTORE_PRIME=1): V1's pre-started spares have nothing to restore."""
    if os.getenv('BOTCUBE_RESTORE_PRIME') == '1':
        prime(region, memory_id)


def prime(region: str, memory_id: str, *, root: Path = ROOT, mount: Callable[[Sequence[str]], None] = run) -> None:
    hold_in_memory(root)
    bind_static_resolver_config(root, mount)
    runtime_credentials(region)
    answer_sdk_calls(region)
    if memory_id:
        agentcore_memory_backend.prime_spare(memory_id, region)


def hold_in_memory(root: Path) -> None:
    """The CA bundles on a tmpfs, named by the variables OpenSSL and botocore read. The resolver's files stay on disk:
    a copy would freeze them at the snapshot, and a restored microVM may need its own."""
    root.mkdir(parents=True)
    system = ssl.get_default_verify_paths().openssl_cafile
    # Some Pythons (uv's CPython) name a system bundle the image lacks; certifi's then serves OpenSSL too.
    bundles = {'SSL_CERT_FILE': system if os.path.isfile(system) else certifi.where(), 'AWS_CA_BUNDLE': certifi.where()}
    for variable, source in bundles.items():
        copy = root / f'{variable.lower()}.pem'
        shutil.copyfile(source, copy)
        os.environ[variable] = str(copy)
    # OpenSSL also looks issuers up by hash in its CA directory; the bundle holds them all, so the directory is empty.
    (root / 'certs').mkdir()
    os.environ['SSL_CERT_DIR'] = str(root / 'certs')


def bind_static_resolver_config(root: Path, mount: Callable[[Sequence[str]], None]) -> None:
    """The image's resolver configuration over tmpfs copies: a restored microVM's first lookup read them from disk."""
    # Binding needs root. Without it the files stay on disk and only the restore's first lookup reads them slowly;
    # a bind refused to root is unexpected and fails the snapshot build, which the deploy's checks then report.
    if os.geteuid() != 0:
        log.warning('Restore prime left the resolver configuration on disk: the Harness does not run as root')
        return
    for path in STATIC_RESOLVER_CONFIG:
        if os.path.isfile(path):
            copy = root / Path(path).name
            shutil.copyfile(path, copy)
            mount(['mount', '--bind', str(copy), path])


def runtime_credentials(region: str) -> None:
    """The runtime role's credentials in the process's sessions. botocore refreshes them when they near expiry, so a
    microVM restored after they expire fetches fresh ones before signing."""
    # The default session is the one `boto3.client` builds the Memory store's and Files' clients from.
    credentials = boto3._get_default_session().get_credentials()
    if credentials is None:
        raise RuntimeError('The Runtime has no AWS credentials to hold before the snapshot')
    credentials.get_frozen_credentials()
    aws_clients.bedrock(region)


class _Body:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def stream(self, **_: Any) -> Iterator[bytes]:
        yield self._body


def _answering(client: Any, event: str, body: bytes) -> Callable[..., AWSResponse]:
    def answer(request: Any, **_: Any) -> AWSResponse:
        return AWSResponse(request.url, 200, HTTPHeaders(), _Body(body))
    client.meta.events.register_first(event, answer)
    return answer


def answer_sdk_calls(region: str) -> None:
    """One STS exchange and one S3 listing through the clients a Turn uses, answered before they leave the process,
    so their request and XML response handling is loaded."""
    sts = agentcore_memory_backend.sts_client(region)
    event = 'before-send.sts.AssumeRoleWithWebIdentity'
    answer = _answering(sts, event, _STS_ANSWER)
    try:
        sts.assume_role_with_web_identity(
            RoleArn='arn:aws:iam::000000000000:role/snapshot', RoleSessionName='snapshot', WebIdentityToken='snapshot' * 3)
    finally:
        sts.meta.events.unregister(event, answer)
    s3 = boto3.client('s3', region_name=region, aws_access_key_id='snapshot', aws_secret_access_key='snapshot')
    _answering(s3, 'before-send.s3.ListObjectsV2', _S3_ANSWER)
    for _page in s3.get_paginator('list_objects_v2').paginate(Bucket='snapshot', Prefix='p/'):
        pass
