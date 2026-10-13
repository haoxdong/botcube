from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .vault import CredentialServiceError

CookieEntry = Mapping[str, Any]
COOKIE_NAME_SEPARATORS = set('()<>@,;:\\"/[]?={} \t')


def is_valid_cookie_entry(cookie: CookieEntry) -> bool:
    name = cookie.get('name')
    value = cookie.get('value')
    domain = cookie.get('domain')
    path = cookie.get('path')
    expires = cookie.get('expires')
    return (
        isinstance(name, str)
        and is_valid_cookie_name(name)
        and isinstance(value, str)
        and is_valid_cookie_value(value)
        and isinstance(domain, str)
        and bool(domain.strip())
        and isinstance(path, str)
        and path.startswith('/')
        and path.strip() == path
        and (expires is None or (not isinstance(expires, bool) and isinstance(expires, (int, float))))
    )


def is_valid_cookie_name(value: str) -> bool:
    return bool(value) and all(
        0x21 <= ord(char) <= 0x7E and char not in COOKIE_NAME_SEPARATORS
        for char in value
    )


def is_valid_cookie_value(value: str) -> bool:
    """RFC 6265's cookie-octets, which allow '=' (base64 padding) but no separator."""
    return all(
        code == 0x21
        or 0x23 <= code <= 0x2B
        or 0x2D <= code <= 0x3A
        or 0x3C <= code <= 0x5B
        or 0x5D <= code <= 0x7E
        for code in (ord(char) for char in value)
    )


def cookie_path_matches(cookie_path: object, request_path: str) -> bool:
    if not isinstance(cookie_path, str) or not cookie_path.startswith('/'):
        return False
    path = cookie_path
    if path == '/':
        return True
    normalized = path.rstrip('/')
    return request_path == normalized or request_path.startswith(f'{normalized}/')


def cookie_unexpired(expires: object, now: float) -> bool:
    if expires is None or isinstance(expires, bool):
        return expires is None
    if isinstance(expires, (int, float)):
        return expires <= 0 or expires > now
    return False


def cookie_identity(cookie: CookieEntry) -> tuple[str, str, str]:
    return (
        str(cookie['name']),
        str(cookie['domain']).strip().lower().lstrip('.'),
        str(cookie['path']),
    )



def parse_session_expiry(expires: object, *, label: str) -> int | float | None:
    """Parse browser session expiries, rejecting malformed values loudly."""
    if expires is None:
        return None
    if isinstance(expires, str):
        try:
            expires = float(expires)
        except ValueError as exc:
            raise CredentialServiceError(f'{label} has a malformed expiry: {expires!r}') from exc
    if isinstance(expires, bool) or not isinstance(expires, (int, float)):
        raise CredentialServiceError(f'{label} has a malformed expiry: {expires!r}')
    return expires
