from __future__ import annotations

import json
import logging
import socket
import sys
from pathlib import Path

import pytest

from botcube_credential_service.botcube_config import load_botcube_config
from botcube_credential_service.endpoint_tls import EndpointTlsError, endpoint_tls
from botcube_credential_service.proxy_relay import (
    start_proxy_relay,
    start_proxy_relay_from_config,
)
from mtls_fake import (
    IMPOSTOR_IDENTITY,
    SERVER_IDENTITY,
    Certificates,
    certificates,
    mtls_proxy,
    tunnel,
)
from required_keys import with_required

pytestmark = pytest.mark.integration

_OPT_IN = {'BOTCUBE_ALLOW_COMMAND_CREDENTIALS': '1'}


@pytest.fixture(scope='module')
def certs(tmp_path_factory: pytest.TempPathFactory) -> Certificates:
    return certificates(tmp_path_factory.mktemp('mtls'))


@pytest.fixture(autouse=True)
def trusted(certs: Certificates, monkeypatch: pytest.MonkeyPatch) -> None:
    # The stand-in CA beside the system roots, as SSL_CERT_FILE adds it in a deployment.
    monkeypatch.setenv('SSL_CERT_FILE', str(certs.authority))


def _relay(upstream: str, tls: dict[str, object], env: dict[str, str] | None = None) -> str:
    return start_proxy_relay(upstream=upstream, listen=('127.0.0.1', 0), credential=None, headers={}, tls=endpoint_tls('proxy', tls, env=env or {}))


def test_relay_presents_the_client_certificate_to_a_proxy_carrying_the_expected_identity(certs: Certificates) -> None:
    with mtls_proxy(certs) as proxy:
        relay = _relay(proxy.url, {'clientCertificate': certs.files('client_a'), 'serverIdentity': SERVER_IDENTITY})

        assert tunnel(relay) == b'HTTP/1.1 200 Connection Established\r\n\r\nhello'
        assert proxy.clients() == ['client-a']


def test_relay_presents_a_replaced_certificate_on_the_next_connection_without_a_restart(certs: Certificates, tmp_path: Path) -> None:
    pair = certs.rotate('client_a', tmp_path / 'svid')
    with mtls_proxy(certs) as proxy:
        relay = _relay(proxy.url, {'clientCertificate': pair, 'serverIdentity': SERVER_IDENTITY})

        tunnel(relay)
        certs.rotate('client_b', tmp_path / 'svid')
        tunnel(relay)

        assert proxy.clients() == ['client-a', 'client-b']


def test_relay_presents_the_certificate_a_command_prints_run_again_for_each_connection(certs: Certificates, tmp_path: Path) -> None:
    printed = tmp_path / 'exec-credential.json'
    printed.write_text(certs.exec_credential('client_a'))
    command = [sys.executable, '-c', f'import sys; sys.stdout.write(open({str(printed)!r}).read())']
    with mtls_proxy(certs) as proxy:
        relay = _relay(proxy.url, {'clientCertificate': {'command': command, 'timeoutSeconds': 10}, 'serverIdentity': SERVER_IDENTITY}, _OPT_IN)

        tunnel(relay)
        printed.write_text(certs.exec_credential('client_b'))
        tunnel(relay)

        assert proxy.clients() == ['client-a', 'client-b']


def test_relay_refuses_another_identity_before_sending_anything_naming_both(certs: Certificates, caplog: pytest.LogCaptureFixture) -> None:
    with mtls_proxy(certs, 'impostor') as proxy, caplog.at_level(logging.ERROR):
        relay = _relay(proxy.url, {'clientCertificate': certs.files('client_a'), 'serverIdentity': SERVER_IDENTITY})

        answer = tunnel(relay).decode('latin-1')

        assert answer.split('\r\n')[0] == 'HTTP/1.1 502 Bad Gateway'
        assert f'expected server identity {SERVER_IDENTITY}, but the server presented {IMPOSTOR_IDENTITY}' in answer
        assert proxy.connections == []
        assert 'PRIVATE KEY' not in answer + caplog.text


def test_relay_still_verifies_the_chain_of_a_proxy_carrying_the_expected_identity(certs: Certificates) -> None:
    with mtls_proxy(certs, 'untrusted') as proxy:
        relay = _relay(proxy.url, {'serverIdentity': SERVER_IDENTITY})

        assert tunnel(relay) == b''
        assert proxy.connections == []


def test_relay_reads_its_tls_from_the_botcube_config_file(certs: Certificates, tmp_path: Path) -> None:
    with mtls_proxy(certs) as proxy:
        tls = {'clientCertificate': certs.files('client_a'), 'serverIdentity': SERVER_IDENTITY}
        path = tmp_path / 'botcube.yaml'
        path.write_text(json.dumps(with_required({'integrations': {'proxy': {'kind': 'forward', 'url': proxy.url, 'tls': tls}}})))
        relay = start_proxy_relay_from_config(load_botcube_config(path), {'HTTPS_PROXY': 'http://127.0.0.1:0'})

        assert relay is not None
        tunnel(relay)
        assert proxy.clients() == ['client-a']


def test_relay_does_not_start_on_a_certificate_it_cannot_read(certs: Certificates, tmp_path: Path) -> None:
    missing = {'certificate': certs.files('client_a')['certificate'], 'key': str(tmp_path / 'missing.key')}

    with pytest.raises(EndpointTlsError, match=r'proxy client certificate \(file .*missing\.key\)'):
        _relay('https://127.0.0.1:9', {'clientCertificate': missing})


def test_a_certificate_command_is_refused_unless_the_deploy_opted_in() -> None:
    with pytest.raises(EndpointTlsError, match=r'proxy client certificate \(command /bin/cat\): a command runs only when BOTCUBE_ALLOW_COMMAND_CREDENTIALS=1'):
        endpoint_tls('proxy', {'clientCertificate': {'command': ['/bin/cat'], 'timeoutSeconds': 5}}, env={})


def test_a_certificate_command_printing_no_certificate_fails_naming_the_command_never_its_output(tmp_path: Path) -> None:
    printed = tmp_path / 'token.json'
    printed.write_text(json.dumps({'kind': 'ExecCredential', 'status': {'token': 'x', 'clientKeyData': '-----BEGIN PRIVATE KEY-----'}}))
    tls = endpoint_tls('proxy', {'clientCertificate': {'command': ['/bin/cat', str(printed)], 'timeoutSeconds': 5}}, env=_OPT_IN)

    with pytest.raises(EndpointTlsError) as raised:
        tls.context()

    assert str(raised.value) == (
        'proxy client certificate (command /bin/cat): the command did not print a Kubernetes ExecCredential '
        'with status.clientCertificateData and status.clientKeyData'
    )


def test_without_tls_an_unreachable_proxy_still_drops_the_client_with_no_answer() -> None:
    with socket.socket() as closed:
        closed.bind(('127.0.0.1', 0))
        port = closed.getsockname()[1]
    relay = start_proxy_relay(upstream=f'http://127.0.0.1:{port}', listen=('127.0.0.1', 0), credential=None, headers={})

    assert tunnel(relay) == b''


def test_a_server_identity_that_is_not_a_uri_is_refused_at_startup() -> None:
    with pytest.raises(EndpointTlsError, match=r'^proxy TLS: serverIdentity: '):
        endpoint_tls('proxy', {'serverIdentity': 'egress proxy'}, env={})
