"""Keep unit and mutation tests offline even if an injected transport disappears."""

from __future__ import annotations

import ipaddress
import socket
import sys
from collections.abc import Iterator
from typing import Any

import pytest

_network_guard_active = False


def _is_loopback(host: object) -> bool:
    if isinstance(host, bytes):
        host = host.decode('ascii')
    if not isinstance(host, str):
        return False
    if host.lower().rstrip('.') == 'localhost':
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _deny_external_network(event: str, args: tuple[Any, ...]) -> None:
    if not _network_guard_active:
        return
    if event in {'socket.getaddrinfo', 'socket.gethostbyname', 'socket.gethostbyaddr'}:
        host = args[0]
        if host is None:  # Passive local address enumeration does not resolve a peer.
            return
    elif event == 'socket.getnameinfo':
        host = args[0][0]
    elif event in {'socket.connect', 'socket.sendto'}:
        if args[0].family not in {socket.AF_INET, socket.AF_INET6}:
            return  # AnyIO's local socket pairs and Unix sockets remain available.
        host = args[1][0]
    else:
        return
    if not _is_loopback(host):
        # Failed derives from BaseException: product Exception handlers cannot turn
        # a guard-first failure into an apparent behavioral mutation kill.
        pytest.fail(f'Offline test blocked non-loopback network: {event}', pytrace=False)


sys.addaudithook(_deny_external_network)


@pytest.fixture(autouse=True)
def offline_network() -> Iterator[None]:
    global _network_guard_active
    _network_guard_active = True
    try:
        yield
    finally:
        _network_guard_active = False
