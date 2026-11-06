from __future__ import annotations

import pytest

from botcube_harness_deepagents.trace_secrets import cookie_secrets, strip_secrets


@pytest.mark.parametrize(('text', 'stripped'), [
    ('{"access_token":"opaque-private-auth', '{"access_token":"[redacted]"'),
    ("password='opaque-private-auth", "password='[redacted]'"),
    ('{"access_token":"opaque-priv\n\n... Output truncated at 28 bytes.',
     '{"access_token":"[redacted]"\n\n... Output truncated at 28 bytes.'),
    ('password="opaque\\"private\\\n\n... Output truncated at 26 bytes.\n\nExit code: 3',
     'password="[redacted]"\n\n... Output truncated at 26 bytes.\n\nExit code: 3'),
    ("password='opaque\\'private", "password='[redacted]'"),
    ('password="opaque\nprivate" dataset=EDRVOL', 'password="[redacted]" dataset=EDRVOL'),
    ('{"access_token":"', '{"access_token":"[redacted]"'),
])
def test_unterminated_named_secrets_do_not_survive_retention(text: str, stripped: str) -> None:
    assert strip_secrets(text) == stripped


@pytest.mark.parametrize('text', [
    'grep -b ordinary.txt',
    'other --user alice:ordinary-value',
    'curl --username alice:ordinary-value',
    'curl -sXsubscribe https://example.com',
    'curl -sAubuntu https://example.com',
    'curl -sb cookies.txt https://example.com',
    'curl --user alice',
    'curl --proxy-user alice',
    'curl -U alice',
    'curl --proxy-username alice:ordinary-value',
    'other -U alice:ordinary-value',
    'curl --cookie cookies.txt https://example.com',
    'curl -b cookies.txt https://example.com',
    'curl https://example.com; grep -b ordinary.txt',
    "curl --data 'ordinary -b a=value' https://example.com",
    'curl https://example.com\ngrep -b ordinary.txt',
])
def test_ordinary_arguments_are_preserved(text: str) -> None:
    assert strip_secrets(text) == text
    assert cookie_secrets(text) == []


def test_shell_cookie_values_are_decoded_for_output_redaction() -> None:
    command = r'''curl -b "a=one\"two; b=three" https://example.com'''
    literals = cookie_secrets(command)
    assert strip_secrets('one"two and three', literals) == '[redacted] and [redacted]'
    assert strip_secrets(command, literals) == 'curl -b [redacted] https://example.com'


@pytest.mark.parametrize('command', [
    "curl >/dev/null --cookie 'a=opaque-first; b=opaque-second'",
    "curl \\\n --cookie 'a=opaque-first; b=opaque-second'",
    "curl --cookie 'a=opaque-first; b=opaque-second",
    "MODE=test curl --cookie 'a=opaque-first; b=opaque-second'",
    "env MODE=test curl --cookie 'a=opaque-first; b=opaque-second'",
    "command curl --cookie 'a=opaque-first; b=opaque-second'",
])
def test_redirected_continued_and_malformed_cookie_commands_lose_secrets(command: str) -> None:
    literals = cookie_secrets(command)
    assert strip_secrets('opaque-first opaque-second', literals) == '[redacted] [redacted]'
    kept = strip_secrets(command, literals)
    assert 'opaque-first' not in kept
    assert 'opaque-second' not in kept


@pytest.mark.parametrize(('text', 'stripped'), [
    ('GET https://b.s3.amazonaws.com/c.png?X-Amz-Signature=abc&width=10 ok',
     'GET https://b.s3.amazonaws.com/c.png?X-Amz-Signature=[redacted]&width=[redacted] ok'),
    ('https://api.example.com/v1/data?access_token=t0k&dataset=EDRVOL',
     'https://api.example.com/v1/data?access_token=[redacted]&dataset=EDRVOL'),
    ('https://user:pass@example.com/x', 'https://[redacted]@example.com/x'),
    ('fetched http://[::1/x?code=abc123&page=2 then stopped', 'fetched http://[::1/x?code=abc123&page=2 then stopped'),
    ('https://api.example.com/v1/data?dataset=EDRVOL', 'https://api.example.com/v1/data?dataset=EDRVOL'),
])
def test_a_url_keeps_its_path_and_loses_its_secrets(text: str, stripped: str) -> None:
    assert strip_secrets(text) == stripped


@pytest.mark.parametrize(('text', 'stripped'), [
    ('{"cookies":[{"name":"ExampleLogin","value":"opaque-cookie-secret"}]}',
     '{"cookies":[{"name":"ExampleLogin","value":"[redacted]"}]}'),
    ('{"data": {"cookies": [\n  {"name": "a", "value": "s1\\"x", "path": "/"},\n  {"name": "b", "value": "s2"}\n]}}',
     '{"data": {"cookies": [\n  {"name": "a", "value": "[redacted]", "path": "/"},\n  {"name": "b", "value": "[redacted]"}\n]}}'),
    ('{"cookies":[{"name":"cut","value":"partial-secret', '{"cookies":[{"name":"cut","value":"[redacted]'),
    ('{"rows":[{"name":"EDRVOL","value":"1.25"}]}', '{"rows":[{"name":"EDRVOL","value":"1.25"}]}'),
])
def test_a_structured_cookie_keeps_its_name_and_loses_its_value(text: str, stripped: str) -> None:
    assert strip_secrets(text) == stripped


@pytest.mark.parametrize('argument', [
    "a='opaque-first",
    'a="opaque-first',
    "'a='opaque-first",
    '"a="opaque-first',
    "a='opaque-first'",
    'a="opaque-first"',
    r'a=opaque\-first',
])
def test_cookie_fragments_decode_before_literal_redaction(argument: str) -> None:
    text = f'curl --cookie {argument}'
    literals = cookie_secrets(text)
    assert strip_secrets('opaque-first', literals) == '[redacted]'
    assert strip_secrets(text, literals) == 'curl --cookie [redacted]'


@pytest.mark.parametrize('argument', [
    "--proxy-user alice:'opaque-private-auth",
    '--proxy-user="alice:opaque-private-auth',
    r'-Ualice:opaque\-private-auth',
    "--user alice:'opaque-private-auth",
    '--user="alice:opaque-private-auth',
    r'-ualice:opaque\-private-auth',
])
def test_curl_credential_fragments_redact_echoed_passwords(argument: str) -> None:
    command = f'curl {argument}'
    literals = cookie_secrets(command)
    assert strip_secrets('opaque-private-auth', literals) == '[redacted]'
    assert 'opaque' not in strip_secrets(command)


@pytest.mark.parametrize('argument', [
    "--oauth2-bearer 'opaque-private-auth'",
    '--oauth2-bearer=opaque-private-auth',
    '--oauth2-bearer="opaque-private-auth',
    r'--oauth2-bearer opaque\-private-auth',
])
def test_curl_oauth_bearer_redacts_commands_and_echoed_tokens(argument: str) -> None:
    command = f'curl {argument}'
    assert 'opaque' not in strip_secrets(command)
    assert strip_secrets('opaque-private-auth', cookie_secrets(command)) == '[redacted]'


@pytest.mark.parametrize(('argument', 'secret'), [
    ("-sb 'a=opaque-first'", 'opaque-first'),
    ('-sba=opaque-first', 'opaque-first'),
    ("-sSu 'alice:opaque-private-auth'", 'opaque-private-auth'),
    ('-sSualice:opaque-private-auth', 'opaque-private-auth'),
])
def test_bundled_curl_options_redact_commands_and_echoed_credentials(argument: str, secret: str) -> None:
    command = f'curl {argument} https://example.com'
    assert secret not in strip_secrets(command)
    assert strip_secrets(secret, cookie_secrets(command)) == '[redacted]'


@pytest.mark.parametrize('option', ['--user=', '--proxy-user=', '--oauth2-bearer='])
def test_empty_curl_credentials_preserve_the_following_url(option: str) -> None:
    command = f'curl {option} https://example.com/data'
    assert strip_secrets(command).endswith(' https://example.com/data')
    assert cookie_secrets(command) == []
