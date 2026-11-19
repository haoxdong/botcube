from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import quote, urlsplit

from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from . import aws_clients

REREAD_AFTER_SECONDS = 300
REFRESH_BEFORE_EXPIRY_SECONDS = 60
ALLOW_COMMAND_CREDENTIALS_ENV = 'BOTCUBE_ALLOW_COMMAND_CREDENTIALS'
# How long STS accepts a SigV4 signature.
SIGV4_VALID_SECONDS = 900
# The header an `aws` source signs its audience into, as Google's signs x-goog-cloud-target-resource.
AWS_AUDIENCE_HEADER = 'x-botcube-audience'


class _Source(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True)


class SecretSource(_Source):
    kind: Literal['secret']
    secret_arn: str = Field(alias='secretArn')


class FileSource(_Source):
    kind: Literal['file']
    path: str


class CommandSource(_Source):
    kind: Literal['command']
    command: list[str] = Field(min_length=1)
    timeout_seconds: int = Field(alias='timeoutSeconds', gt=0)


class AwsSource(_Source):
    kind: Literal['aws']
    audience: str


class BotCubeSource(_Source):
    kind: Literal['botcube']
    audience: str


Source = Annotated[SecretSource | FileSource | CommandSource | AwsSource | BotCubeSource, Field(discriminator='kind')]
_SOURCE: TypeAdapter[Source] = TypeAdapter(Source)


class CredentialSourceError(RuntimeError):
    pass


@dataclass(frozen=True)
class Credential:
    value: str = field(repr=False)
    # None for a token its source gave no expiry: it is kept for the life of the process, as kubectl keeps one.
    expires_at: float | None


class CredentialSource:
    def __init__(self, named: str, read: Callable[[], Credential], now: Callable[[], float]) -> None:
        self._named = named
        self._read = read
        self._now = now
        self._cached: Credential | None = None
        self._lock = threading.Lock()

    def get(self) -> Credential:
        with self._lock:
            if self._cached is None or not self._fresh(self._cached):
                try:
                    self._cached = self._read()
                except Exception as error:
                    raise CredentialSourceError(f'{self._named}: {error}') from error
            return self._cached

    def _fresh(self, credential: Credential) -> bool:
        return credential.expires_at is None or self._now() < credential.expires_at - REFRESH_BEFORE_EXPIRY_SECONDS


def credential_source(
    seam: str,
    source: object,
    *,
    env: Mapping[str, str] = os.environ,
    now: Callable[[], float] = time.time,
) -> CredentialSource:
    """The `source` of `seam`, such as `models`; a malformed source, or a command the deploy did not opt in to, is refused here, at startup."""
    try:
        parsed = _SOURCE.validate_python(source)
    except ValidationError as error:
        raise CredentialSourceError('\n'.join(f'{seam} credential: {_field(issue)}: {issue["msg"]}' for issue in error.errors())) from None
    match parsed:
        case SecretSource(secret_arn=arn):
            return CredentialSource(f'{seam} credential (secret {arn})', lambda: Credential(_secret_string(arn), now() + REREAD_AFTER_SECONDS), now)
        case FileSource(path=path):
            return CredentialSource(f'{seam} credential (file {path})', lambda: Credential(_file_text(path), now() + REREAD_AFTER_SECONDS), now)
        case CommandSource(command=command, timeout_seconds=timeout):
            named = f'{seam} credential (command {command[0]})'
            if env.get(ALLOW_COMMAND_CREDENTIALS_ENV) != '1':
                raise CredentialSourceError(f'{named}: a command credential runs only when {ALLOW_COMMAND_CREDENTIALS_ENV}=1')
            return CredentialSource(named, lambda: _exec_credential(_stdout_of(command, timeout)), now)
        case AwsSource(audience=audience):
            return CredentialSource(
                f'{seam} credential (aws {audience})', lambda: Credential(_caller_identity_request(audience, env), now() + SIGV4_VALID_SECONDS), now,
            )
        case BotCubeSource(audience=audience):
            raise CredentialSourceError(f'{seam} credential (botcube {audience}): only the Chat Service signs a botcube token, with its Turn identity keys')


def credential_source_from_env(seam: str, name: str, env: Mapping[str, str] = os.environ) -> CredentialSource | None:
    value = env.get(name)
    if not value:
        return None
    try:
        source = json.loads(value)
    except ValueError:
        raise CredentialSourceError(f'{name}: not JSON') from None
    return credential_source(seam, source, env=env)


def _field(issue: object) -> str:
    loc = issue['loc'] if isinstance(issue, dict) else ()
    return '.'.join(str(part) for part in loc) or 'kind'


def _secret_string(arn: str) -> str:
    client = aws_clients.session().client('secretsmanager', region_name=arn.split(':')[3])
    value = client.get_secret_value(SecretId=arn).get('SecretString')
    if not value:
        raise ValueError('the secret holds no string')
    return value


def _caller_identity_request(audience: str, env: Mapping[str, str]) -> str:
    """
    The process's AWS identity as Google's external-account `aws` subject token serializes it: a SigV4-signed
    sts:GetCallerIdentity request in the process's region, its audience signed in, as URL-encoded JSON.
    """
    region = env.get('AWS_REGION') or env.get('AWS_DEFAULT_REGION') or 'us-east-1'
    endpoint = urlsplit(env.get('AWS_ENDPOINT_URL_STS') or f'https://sts.{region}.amazonaws.com')
    url = f'{endpoint.scheme}://{endpoint.netloc}/?Action=GetCallerIdentity&Version=2011-06-15'
    request = AWSRequest(method='POST', url=url, headers={'host': endpoint.netloc, AWS_AUDIENCE_HEADER: audience})
    credentials = aws_clients.session().get_credentials()
    if credentials is None:
        raise RuntimeError('the process has no AWS credentials')
    SigV4Auth(credentials.get_frozen_credentials(), 'sts', region).add_auth(request)
    headers = [{'key': key, 'value': value} for key, value in request.headers.items()]
    return quote(json.dumps({'url': url, 'method': 'POST', 'headers': headers}, separators=(',', ':')), safe='')


def _file_text(path: str) -> str:
    with open(path, encoding='utf-8') as file:
        value = file.read().removesuffix('\n').removesuffix('\r')
    if not value:
        raise ValueError('the file is empty')
    return value


def _stdout_of(command: list[str], timeout: int) -> str:
    """What the command prints on stdout; its stderr is discarded unread, since a helper may write a secret there."""
    try:
        finished = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise TimeoutError(f'the command did not finish within {timeout} s') from None
    if finished.returncode != 0:
        raise RuntimeError(f'the command exited with code {finished.returncode}')
    return finished.stdout.decode('utf-8', errors='replace')


def _exec_credential(stdout: str) -> Credential:
    """The token of the Kubernetes `ExecCredential` a command printed, and its `expirationTimestamp` if it gave one."""
    malformed = ValueError('the command did not print a Kubernetes ExecCredential with status.token')
    try:
        printed = json.loads(stdout)
    except ValueError:
        raise malformed from None
    status = printed.get('status') if isinstance(printed, dict) else None
    if not isinstance(status, dict) or printed.get('kind') != 'ExecCredential':
        raise malformed
    token = status.get('token')
    if not isinstance(token, str) or not token:
        raise malformed
    expiry = status.get('expirationTimestamp')
    if expiry is None:
        return Credential(token, None)
    try:
        return Credential(token, datetime.fromisoformat(expiry).timestamp())
    except (TypeError, ValueError):
        raise malformed from None
