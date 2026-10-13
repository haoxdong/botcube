"""Compose the public encrypted entry engine with offline template site policy."""
import asyncio
import base64
import json
from collections.abc import Mapping
from html.parser import HTMLParser

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from botcube_credential_service.sign_in import (
    InputField,
    SheetKey,
    SignInPageChanged,
    type_credentials,
)
from botcube_template.fake_site import FakeSiteServer

# The template's production login needs only its Sign-in button. This offline form
# demonstrates how a cartridge supplies trusted selectors for a two-step provider.
LOGIN_FORM = '<form><input name="username" type="text"><input name="password" type="password"></form>'
USERNAME = InputField('username', 'input[name="username"]', lambda active: active.get('name') == 'username')
PASSWORD = InputField('password', 'input[type="password"]', lambda active: active.get('type') == 'password')


class Form(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.fields: list[dict[str, str | None]] = []
        self.feed(LOGIN_FORM)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == 'input':
            self.fields.append(dict(attrs))


class OfflineCdpPage:
    def __init__(self, origin: str, *, change_origin: bool) -> None:
        self.origin = origin
        self.change_origin = change_origin
        self.fields = Form().fields
        self.calls: list[tuple[str, Mapping[str, object]]] = []
        self.step = 0

    async def send(self, method: str, params: Mapping[str, object]) -> Mapping[str, object]:
        self.calls.append((method, params))
        if method == 'Runtime.evaluate':
            selector = (USERNAME, PASSWORD)[self.step].selector
            assert json.dumps(selector) in str(params['expression'])
            origin = 'https://untrusted.example.test' if self.change_origin and self.step else self.origin
            return {'result': {'value': {'origin': origin, 'path': '/login', **self.fields[self.step]}}}
        assert method in {'Input.insertText', 'Input.dispatchKeyEvent'}
        if method == 'Input.dispatchKeyEvent' and params['type'] == 'keyUp':
            self.step += 1
        return {}


def seal(key: SheetKey, username: str, password: str) -> str:
    public = serialization.load_der_public_key(base64.b64decode(key.public_key()))
    assert isinstance(public, rsa.RSAPublicKey)
    return base64.b64encode(public.encrypt(
        json.dumps({'username': username, 'password': password}).encode(),
        padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
    )).decode()


@pytest.mark.parametrize('change_origin', [False, True])
def test_template_policy_types_sealed_input_only_on_its_trusted_site(change_origin: bool) -> None:
    with FakeSiteServer(('127.0.0.1', 0)) as site:
        origin = f'http://127.0.0.1:{site.server_port}'
        page = OfflineCdpPage(origin, change_origin=change_origin)
        key = SheetKey()
        username, password = key.open(seal(key, 'template-user', 'template-password'))
        entry = type_credentials(
            page, ((USERNAME, username), (PASSWORD, password)),
            origins=frozenset({origin}), origin_error='The template sign-in origin changed',
        )
        if change_origin:
            with pytest.raises(SignInPageChanged, match='template sign-in origin changed'):
                asyncio.run(entry)
        else:
            asyncio.run(entry)

    typed = [params['text'] for method, params in page.calls if method == 'Input.insertText']
    assert typed == (['template-user'] if change_origin else ['template-user', 'template-password'])
    # Each field gets only the fixed focus probe, input and Enter; a changed
    # origin stops the password before any input command can contain it.
    assert [method for method, _ in page.calls] == (
        ['Runtime.evaluate', 'Input.insertText', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent']
        + (['Runtime.evaluate'] if change_origin else
           ['Runtime.evaluate', 'Input.insertText', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent'])
    )
    if change_origin:
        assert 'template-password' not in json.dumps(page.calls)
