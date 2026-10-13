import pytest

from botcube_credential_service.cookies import (
    cookie_identity,
    cookie_path_matches,
    cookie_unexpired,
    is_valid_cookie_entry,
    parse_session_expiry,
)
from botcube_credential_service.vault import CredentialServiceError


@pytest.mark.parametrize('cookie_path,request_path,matched', [
    ('/', '/api', True), ('/api/', '/api', True), ('/api', '/api/items', True),
    ('/api', '/apiculture', False), ('api', '/api', False),
])
def test_cookie_paths_match_whole_segments(cookie_path: str, request_path: str, matched: bool) -> None:
    assert cookie_path_matches(cookie_path, request_path) is matched


@pytest.mark.parametrize('expires,live', [(None, True), (-1, True), (0, True), (99, False), (101, True), (True, False)])
def test_cookie_expiry_at_request_time(expires: object, live: bool) -> None:
    assert cookie_unexpired(expires, 100) is live


def test_browser_expiry_parsing_rejects_malformed_values() -> None:
    assert parse_session_expiry('101', label='Session cookie') == 101
    for expires in ('invalid', True, {}, []):
        with pytest.raises(CredentialServiceError, match='malformed expiry'):
            parse_session_expiry(expires, label='Session cookie')


def test_cookie_headers_reject_separator_injection() -> None:
    cookie = {'name': 'session', 'value': 'token==', 'domain': '.EXAMPLE.test', 'path': '/'}
    assert is_valid_cookie_entry(cookie)
    assert cookie_identity(cookie) == ('session', 'example.test', '/')
    for name, value in [('session;other', 'token'), ('session', 'token\r\nInjected: header')]:
        assert not is_valid_cookie_entry({**cookie, 'name': name, 'value': value})
