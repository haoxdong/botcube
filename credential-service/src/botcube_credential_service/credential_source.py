from __future__ import annotations

import base64
import json
import logging
import os
import subprocess
import threading
import time
from collections.abc import Callable, Mapping
from concurrent.futures import Future
from dataclasses import dataclass, field
from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import quote, quote_plus, urlsplit

import boto3
import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

REREAD_AFTER_SECONDS = 300
MANDATORY_REFRESH_WINDOW_SECONDS = 60
ADVISORY_REFRESH_WINDOW_MAX_SECONDS = 900
REFRESH_THREAD_NAME = 'credential-refresh'
ALLOW_COMMAND_CREDENTIALS_ENV = 'BOTCUBE_ALLOW_COMMAND_CREDENTIALS'
# How long STS accepts a SigV4 signature.
SIGV4_VALID_SECONDS = 900
# The header an `aws` source signs its audience into, as Google's signs x-goog-cloud-target-resource.
AWS_AUDIENCE_HEADER = 'x-botcube-audience'


class _Source(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True)


class SecretSource(_Source):
    kind: Literal['secret']
    secret_id: str = Field(alias='secretId')


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


class OAuthClientCredentialsSource(_Source):
    kind: Literal['oauth-client-credentials']
    token_endpoint: str = Field(alias='tokenEndpoint')
    client_id: str = Field(alias='clientId', min_length=1)
    client_secret: Annotated[SecretSource | FileSource | CommandSource, Field(discriminator='kind')] = Field(alias='clientSecret')
    scopes: list[str] | None = None


Source = Annotated[
    SecretSource | FileSource | CommandSource | OAuthClientCredentialsSource | AwsSource | BotCubeSource, Field(discriminator='kind'),
]
_SOURCE: TypeAdapter[Source] = TypeAdapter(Source)


log = logging.getLogger(__name__)


class CredentialSourceError(RuntimeError):
    pass


class _Refused(Exception):
    def __init__(self, about: str, reason: str) -> None:
        super().__init__(reason)
        self.about = about
        self.reason = reason


@dataclass(frozen=True)
class Credential:
    value: str = field(repr=False)
    # None for a token its source gave no expiry: it is kept for the life of the process, as kubectl keeps one.
    expires_at: float | None


@dataclass(frozen=True)
class _CachedCredential:
    credential: Credential
    advisory_at: float
    mandatory_at: float


class CredentialSource:
    def __init__(
        self, named: str, read: Callable[[], Credential], now: Callable[[], float],
    ) -> None:
        self._named = named
        self._read = read
        self._now = now
        self._cached: _CachedCredential | None = None
        self._refreshing: Future[Credential] | None = None
        self._lock = threading.Lock()

    def get(self) -> Credential:
        with self._lock:
            now = self._now()
            cached = self._cached
            if cached is not None and now < cached.mandatory_at:
                if now >= cached.advisory_at:
                    self._refresh()
                return cached.credential
            refreshing = self._refresh()
        return refreshing.result()

    def _refresh(self) -> Future[Credential]:
        if self._refreshing is None:
            self._refreshing = Future()
            self._refreshing.add_done_callback(_log_refresh_failure)
            threading.Thread(target=self._mint, args=(self._refreshing,), name=REFRESH_THREAD_NAME, daemon=True).start()
        return self._refreshing

    def _mint(self, refreshing: Future[Credential]) -> None:
        try:
            credential = self._read()
        except Exception as error:
            failure = CredentialSourceError(f'{self._named}: {error}')
            failure.__cause__ = error
            with self._lock:
                self._refreshing = None
            refreshing.set_exception(failure)
            return
        with self._lock:
            self._cached = _with_refresh_windows(credential, self._now())
            self._refreshing = None
        refreshing.set_result(credential)


def _log_refresh_failure(refreshing: Future[Credential]) -> None:
    if (failure := refreshing.exception()) is not None:
        log.warning('Credential refresh failed: %s', failure)


def _with_refresh_windows(credential: Credential, minted_at: float) -> _CachedCredential:
    if credential.expires_at is None:
        return _CachedCredential(credential, float('inf'), float('inf'))
    expiry = credential.expires_at
    half_lifetime = (expiry - minted_at) / 2
    return _CachedCredential(credential, expiry - min(half_lifetime, ADVISORY_REFRESH_WINDOW_MAX_SECONDS), expiry - MANDATORY_REFRESH_WINDOW_SECONDS)


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
    try:
        about, read = _adapter(parsed, env, now)
    except _Refused as refused:
        raise CredentialSourceError(f'{seam} credential ({refused.about}): {refused.reason}') from None
    return CredentialSource(f'{seam} credential ({about})', read, now)


def _adapter(source: Source, env: Mapping[str, str], now: Callable[[], float]) -> tuple[str, Callable[[], Credential]]:
    match source:
        case SecretSource(secret_id=secret_id):
            return f'secret {secret_id}', lambda: Credential(_secret_string(secret_id, env), now() + REREAD_AFTER_SECONDS)
        case FileSource(path=path):
            return f'file {path}', lambda: Credential(_file_text(path), now() + REREAD_AFTER_SECONDS)
        case CommandSource(command=command, timeout_seconds=timeout):
            if env.get(ALLOW_COMMAND_CREDENTIALS_ENV) != '1':
                raise _Refused(f'command {command[0]}', f'a command credential runs only when {ALLOW_COMMAND_CREDENTIALS_ENV}=1')
            return f'command {command[0]}', lambda: _exec_credential(stdout_of(command, timeout))
        case OAuthClientCredentialsSource():
            return _oauth_adapter(source, env, now)
        case AwsSource(audience=audience):
            return f'aws {audience}', lambda: Credential(_caller_identity_request(audience, env), now() + SIGV4_VALID_SECONDS)
        case BotCubeSource(audience=audience):
            raise _Refused(f'botcube {audience}', 'only the Chat Service signs a botcube token, with its Turn identity keys')


def _oauth_adapter(source: OAuthClientCredentialsSource, env: Mapping[str, str], now: Callable[[], float]) -> tuple[str, Callable[[], Credential]]:
    about = f'oauth-client-credentials {source.token_endpoint}'
    try:
        secret_about, read_secret = _adapter(source.client_secret, env, now)
    except _Refused as refused:
        raise _Refused(about, f'client secret ({refused.about}): {refused.reason}') from None

    def read() -> Credential:
        try:
            secret = read_secret().value
        except Exception as error:
            raise RuntimeError(f'client secret ({secret_about}): {error}') from error
        return _client_credentials_grant(source, secret, now)

    return about, read


def _field(issue: object) -> str:
    loc = issue['loc'] if isinstance(issue, dict) else ()
    return '.'.join(str(part) for part in loc) or 'kind'


def _secret_string(secret_id: str, env: Mapping[str, str]) -> str:
    """The secret's string: an ARN's in its own region, a name's in the process's."""
    region = secret_id.split(':')[3] if secret_id.startswith('arn:') else env.get('AWS_REGION') or env.get('AWS_DEFAULT_REGION')
    client = boto3.Session().client('secretsmanager', region_name=region)
    value = client.get_secret_value(SecretId=secret_id).get('SecretString')
    if not value:
        raise ValueError('the secret holds no string')
    return value


class _TokenEndpointError(RuntimeError):
    pass


class _TokenReply(BaseModel):
    access_token: str = Field(min_length=1)
    expires_in: float | None = Field(default=None, gt=0)


class _ErrorReply(BaseModel):
    # RFC 6749 section 5.2's error code, a registered token such as invalid_client; its description may echo the request.
    error: str = Field(pattern=r'^[\x20-\x21\x23-\x5B\x5D-\x7E]+$')


def _client_credentials_grant(source: OAuthClientCredentialsSource, client_secret: str, now: Callable[[], float]) -> Credential:
    """RFC 6749 section 4.4: the client authenticates with HTTP Basic, its id and secret each form-encoded."""
    basic = base64.b64encode(f'{quote_plus(source.client_id)}:{quote_plus(client_secret)}'.encode()).decode()
    form = {'grant_type': 'client_credentials', **({'scope': ' '.join(source.scopes)} if source.scopes else {})}
    response = httpx.post(source.token_endpoint, data=form, headers={'authorization': f'Basic {basic}', 'accept': 'application/json'})
    if not response.is_success:
        try:
            error = _ErrorReply.model_validate_json(response.content)
        except ValidationError:
            raise _TokenEndpointError(f'the token endpoint answered {response.status_code}') from None
        raise _TokenEndpointError(f'the token endpoint answered {response.status_code} {error.error}')
    try:
        token = _TokenReply.model_validate_json(response.content)
    except ValidationError:
        raise _TokenEndpointError('the token endpoint did not answer with an access_token') from None
    if token.expires_in is not None:
        return Credential(token.access_token, now() + token.expires_in)
    expiry = _jwt_expiry(token.access_token)
    return Credential(token.access_token, now() + REREAD_AFTER_SECONDS if expiry is None else expiry)


class _JwtClaims(BaseModel):
    exp: float | None = None


def _jwt_expiry(token: str) -> float | None:
    # RFC 6749 section 5.1 only recommends expires_in; an access token that is a JWT still carries its own exp.
    parts = token.split('.')
    if len(parts) != 3:
        return None
    try:
        return _JwtClaims.model_validate_json(base64.urlsafe_b64decode(parts[1] + '=' * (-len(parts[1]) % 4))).exp
    except ValueError:
        return None


def _caller_identity_request(audience: str, env: Mapping[str, str]) -> str:
    """
    The process's AWS identity as Google's external-account `aws` subject token serializes it: a SigV4-signed
    sts:GetCallerIdentity request in the process's region, its audience signed in, as URL-encoded JSON.
    """
    region = env.get('AWS_REGION') or env.get('AWS_DEFAULT_REGION') or 'us-east-1'
    endpoint = urlsplit(env.get('AWS_ENDPOINT_URL_STS') or f'https://sts.{region}.amazonaws.com')
    url = f'{endpoint.scheme}://{endpoint.netloc}/?Action=GetCallerIdentity&Version=2011-06-15'
    request = AWSRequest(method='POST', url=url, headers={'host': endpoint.netloc, AWS_AUDIENCE_HEADER: audience})
    credentials = boto3.Session().get_credentials()
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


def stdout_of(command: list[str], timeout: int) -> str:
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
