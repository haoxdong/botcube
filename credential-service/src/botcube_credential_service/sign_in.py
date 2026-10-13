from __future__ import annotations

import asyncio
import base64
import binascii
import itertools
import json
import os
import ssl
import time
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Protocol

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

FIELD_WAIT_SECONDS = 15.0
_PROBE_INTERVAL_SECONDS = 0.25
# How long the automation stream may take to answer one CDP command.
_REPLY_TIMEOUT_SECONDS = 10.0
_KEY_BITS = 2048
_OAEP = padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None)


class SheetEntryRefused(Exception):
    """The Credential Service refused to type the sheet's credentials; nothing more is typed."""

    code = 'sheet_entry_refused'


class NotEncryptedToCredentialService(SheetEntryRefused):
    code = 'not_encrypted_to_credential_service'


class SignInPageChanged(SheetEntryRefused):
    code = 'sign_in_page_changed'


class SheetKey:
    """An RSA-OAEP-256 key pair that lives only in this process's memory."""

    def __init__(self) -> None:
        self._private_key = rsa.generate_private_key(public_exponent=65537, key_size=_KEY_BITS)

    def public_key(self) -> str:
        """The public key as base64 DER SubjectPublicKeyInfo, which WebCrypto imports as `spki`."""
        der = self._private_key.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        return base64.b64encode(der).decode()

    def open(self, sealed: str) -> tuple[str, str]:
        """The username and password sealed to this key; anything else is refused."""
        try:
            plaintext = self._private_key.decrypt(base64.b64decode(sealed, validate=True), _OAEP)
            credentials = json.loads(plaintext)
        except (binascii.Error, ValueError):
            raise NotEncryptedToCredentialService('Credentials are not encrypted to the Credential Service') from None
        username = credentials.get('username') if isinstance(credentials, dict) else None
        password = credentials.get('password') if isinstance(credentials, dict) else None
        if not isinstance(username, str) or not username or not isinstance(password, str) or not password:
            raise NotEncryptedToCredentialService('Sealed credentials need a username and a password')
        return username, password


class CdpPage(Protocol):
    """A CDP session attached to the Auth Browser Session's page."""

    async def send(self, method: str, params: Mapping[str, object]) -> Mapping[str, object]: ...


def _focus_probe(selector: str) -> str:
    # Focuses the field and selects any text a rejected attempt left in it, so typing
    # replaces it; answers only the top-level origin and path and the focused element's
    # type and name (ADR 0075): never a value, the DOM, or cookies.
    return (
        '(() => {'
        f' const field = document.querySelector({json.dumps(selector)});'
        ' if (field) { field.focus(); field.select(); }'
        ' const active = document.activeElement;'
        ' return { origin: location.origin, path: location.pathname, type: active?.type ?? null, name: active?.name ?? null };'
        ' })()'
    )


@dataclass(frozen=True)
class InputField:
    step: str
    selector: str
    accepts: Callable[[Mapping[str, object]], bool]

    @property
    def probe(self) -> str:
        return _focus_probe(self.selector)


ENTRY_METHODS = frozenset({'Runtime.evaluate', 'Input.insertText', 'Input.dispatchKeyEvent'})


class InputOnly:
    """The only CDP surface entry may use: input methods and the fixed focus probes."""

    def __init__(self, page: CdpPage, fields: tuple[InputField, ...]) -> None:
        self._page = page
        self._probes = {field.probe for field in fields}

    async def send(self, method: str, params: Mapping[str, object]) -> Mapping[str, object]:
        probes = self._probes  # pragma: no mutate: type_credentials sends nothing else, so this refusal is unreachable
        if method not in ENTRY_METHODS or (method == 'Runtime.evaluate' and params.get('expression') not in probes):  # pragma: no mutate: type_credentials sends nothing else, so this refusal is unreachable
            raise SheetEntryRefused(f'CDP method {method} is not allowed during sign-in entry')  # pragma: no mutate: type_credentials sends nothing else, so this refusal is unreachable
        return await self._page.send(method, params)


async def _await_focused(page: InputOnly, field: InputField, deadline: float, origins: frozenset[str], origin_error: str) -> None:
    while True:
        response = await page.send('Runtime.evaluate', {'expression': field.probe, 'returnByValue': True})
        result = response.get('result')
        active = result.get('value') if isinstance(result, Mapping) else None
        if not isinstance(active, Mapping):
            raise SignInPageChanged('The sign-in page did not answer the field check')
        if active.get('origin') not in origins:
            raise SignInPageChanged(origin_error)
        if field.accepts(active):
            return
        if time.monotonic() >= deadline:
            raise SignInPageChanged(f'The sign-in page has no field for this credential: {_page_seen(field, active)}')
        await asyncio.sleep(_PROBE_INTERVAL_SECONDS)


def _page_seen(field: InputField, active: Mapping[str, object]) -> str:
    """What the last field check saw: the step, the page, and the focused element's type and name."""
    return (
        f"{field.step} step on {active.get('origin')}{active.get('path') or ''}, "
        f"focused type={json.dumps(active.get('type'))} name={json.dumps(active.get('name'))}"
    )


async def type_credentials(
    page: CdpPage, entries: tuple[tuple[InputField, str], ...], *,
    origins: frozenset[str], origin_error: str,
) -> None:
    """Type credentials using trusted provider policy, checking origin before each field."""
    entry = InputOnly(page, tuple(field for field, _ in entries))
    deadline = time.monotonic() + FIELD_WAIT_SECONDS
    for field, text in entries:
        try:
            await _await_focused(entry, field, deadline, origins, origin_error)
            await entry.send('Input.insertText', {'text': text})
            for event in ('keyDown', 'keyUp'):
                await entry.send(
                    'Input.dispatchKeyEvent',
                    {'type': event, 'key': 'Enter', 'code': 'Enter', 'windowsVirtualKeyCode': 13, 'text': '\r'},
                )
        except (CdpError, OSError, TimeoutError) as exc:
            exc.add_note(f'while entering {field.selector}')
            raise


class CdpError(Exception):
    """The Auth Browser Session's automation stream failed or answered an error."""


class _AutomationStreamPage:
    def __init__(self, socket: Any, page_session_id: str | None = None) -> None:
        self._socket = socket
        self._page_session_id = page_session_id
        # CDP matches each reply to its command by id, so ids need only be distinct: any start serves.
        self._ids = itertools.count()

    async def send(self, method: str, params: Mapping[str, object]) -> Mapping[str, object]:
        message_id = next(self._ids)
        message: dict[str, object] = {'id': message_id, 'method': method, 'params': dict(params)}
        if self._page_session_id is not None:
            message['sessionId'] = self._page_session_id
        await self._socket.send(json.dumps(message))
        while True:
            reply = json.loads(await asyncio.wait_for(self._socket.recv(), timeout=_REPLY_TIMEOUT_SECONDS))
            if reply.get('id') != message_id:
                continue
            if 'error' in reply:
                raise CdpError(f"CDP {method} failed: {reply['error'].get('message')}")
            result = reply.get('result')
            return result if isinstance(result, Mapping) else {}


@asynccontextmanager
async def open_browser_page(variable: str, missing: str, browser_session_id: str) -> AsyncIterator[CdpPage]:
    """Attach to a browser Session's page, in the browser `variable` names, over its SigV4-signed automation stream."""
    import boto3
    import certifi
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest
    from websockets.asyncio.client import connect

    browser_id = os.getenv(variable, '').strip()
    if not browser_id:
        raise CdpError(missing)
    session = boto3.session.Session()
    client = session.client('bedrock-agentcore')
    browser = await asyncio.to_thread(client.get_browser_session, browserIdentifier=browser_id, sessionId=browser_session_id)
    endpoint = browser['streams']['automationStream']['streamEndpoint']
    request = AWSRequest(method='GET', url=endpoint.replace('wss://', 'https://', 1))
    credentials = session.get_credentials()
    if credentials is None:
        raise CdpError('No AWS credentials for the automation stream')
    SigV4Auth(credentials.get_frozen_credentials(), 'bedrock-agentcore', client.meta.region_name).add_auth(request)
    # certifi, like httpx and botocore here: the image has no system CA store for ssl's default context.
    tls = ssl.create_default_context(cafile=certifi.where())
    async with connect(endpoint, additional_headers=dict(request.headers.items()), max_size=None, ssl=tls) as socket:
        browser_target = _AutomationStreamPage(socket)
        targets = await browser_target.send('Target.getTargets', {})
        infos = targets.get('targetInfos')
        target_id = next(
            (info.get('targetId') for info in infos if isinstance(info, Mapping) and info.get('type') == 'page'),
            None,
        ) if isinstance(infos, list) else None
        if not isinstance(target_id, str):
            raise CdpError('No page target in the Auth Browser Session')
        attached = await browser_target.send('Target.attachToTarget', {'targetId': target_id, 'flatten': True})
        page_session_id = attached.get('sessionId')
        if not isinstance(page_session_id, str):
            raise CdpError('Could not attach to the Auth Browser Session page')
        yield _AutomationStreamPage(socket, page_session_id)
