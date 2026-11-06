from __future__ import annotations

import re
from collections.abc import Iterable, Iterator, Mapping
from itertools import groupby

REDACTED = '[redacted]'

_SECRET_NAME = r'token|secret|password|passwd|cookie|session|credential|authorization|api[-_]?key|signature'
_SECRET_NAME_RE = re.compile(_SECRET_NAME, re.IGNORECASE)
_SIGNING_PARAM = re.compile(r'^(x-amz-[\w-]+|x-goog-[\w-]+|signature|sig|policy|key-pair-id|se|sp|sv|sr|skoid)$', re.IGNORECASE)
_JWT = re.compile(r'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}')
_AUTH_SCHEME = re.compile(r'\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}', re.IGNORECASE)
_HEADER_LINE = re.compile(
    r'^((?:\[stderr\]\s*)?[<>*]?\s*(?:authorization|proxy-authorization|cookie|set-cookie|[\w-]*token[\w-]*|[\w-]*session[\w-]*)\s*:\s*).+$',
    re.IGNORECASE | re.MULTILINE,
)
_QUOTED_COOKIE_HEADER = re.compile(r"""(["'])((?:cookie|set-cookie)\s*:\s*)[^\r\n]*?\1""", re.IGNORECASE)
_URL = re.compile(r"\bhttps?://[^\s\"'<>`]+")
_NAMED_VALUE = re.compile(
    rf"""\b([\w-]*(?:{_SECRET_NAME})[\w-]*)(["']?\s*[=:]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|"(?:[^"\\\r\n]|\\[^\r\n])*\\?(?=\r?\n|$)|'(?:[^'\\\r\n]|\\[^\r\n])*\\?(?=\r?\n|$)|[^\s&;,"'}}{{\[][^\s&;,"'}}]*)""",
    re.IGNORECASE,
)
_COOKIE_BLOCK = re.compile(r'"[\w-]*cookie[\w-]*"\s*:\s*[\[{]', re.IGNORECASE)
_JSON_VALUE = re.compile(r'("value"\s*:\s*")(?:[^"\\]|\\.)*("?)')
_USER_INFO = re.compile(r'^(https?://)[^/@\s?#]+@')
_QUERY_PAIR = re.compile(r'([^=&#]+)=([^&#]*)')
_QUERY_PAIR_TEXT = re.compile(r'([^=&#]+)=[^&#]*')
_MIN_LITERAL_SECRET = 8
_SHELL_PART = r'''"((?:[^"\\]|\\[\s\S])*)(?:"|$)|'([^']*)(?:'|$)|\\([\s\S])|([^\s'"\\;|&()<>])'''
_CURL_SECRET_OPTIONS = {'--cookie': '=', '-b': '=', '--user': ':', '-u': ':', '--proxy-user': ':', '-U': ':', '--oauth2-bearer': ''}
_SHELL_WORD = rf'(?:{_SHELL_PART})+'
_SHELL_TOKEN = re.compile(rf'{_SHELL_WORD}|[;|&()\n]|[<>]+')


def _shell_word(token: re.Match[str]) -> str:
    decoded = []
    for part in re.finditer(_SHELL_PART, token.group(0)):
        double, single, escaped, plain = part.groups()
        if double is not None:
            decoded.append(re.sub(r'\\(["\\\n])', lambda match: match.group(1).replace('\n', ''), double))
        elif single is not None:
            decoded.append(single)
        elif escaped is not None:
            decoded.append(escaped.replace('\n', ''))
        else:
            decoded.append(plain)
    return ''.join(decoded)


def _curl_words(text: str) -> Iterator[Iterator[re.Match[str]]]:
    for is_command, group in groupby(_SHELL_TOKEN.finditer(text), key=lambda token: token.group(0) not in ';|&()\n'):
        if is_command:
            tokens = iter(group)
            for first in tokens:
                word = _shell_word(first)
                if word in ('env', 'command', 'exec') or word.startswith('-') or re.match(r'^[A-Za-z_]\w*=', word):
                    continue
                if word.rsplit('/', 1)[-1] == 'curl':
                    yield tokens
                break


def _secret_arguments(text: str) -> Iterator[tuple[re.Match[str], str, str, str]]:
    for tokens in _curl_words(text):
        for token in tokens:
            word = _shell_word(token)
            if token.group(0) in ('<', '>', '>>', '<<'):
                next(tokens, None)
            elif word in _CURL_SECRET_OPTIONS or re.fullmatch(r'-[012346aBfgGiIjJklLMnNOpqRsSvVZ#]+[buU]', word):
                value = next(tokens, None)
                if value is not None:
                    yield value, '', _shell_word(value), _curl_secret_separator(word)
            elif option := re.match(r'^(--(?:cookie|user|proxy-user|oauth2-bearer)=|-[012346aBfgGiIjJklLMnNOpqRsSvVZ#]*[buU])', word):
                prefix = option.group(0)
                yield token, prefix, word[len(prefix):], _curl_secret_separator(prefix)


def _curl_secret_separator(option: str) -> str:
    name = option.removesuffix('=') if option.startswith('--') else f'-{option[-1]}'
    return _CURL_SECRET_OPTIONS[name]


def cookie_secrets(command: str) -> list[str]:
    """Cookie and curl credential literals shared by retained command and output redaction."""
    values: set[str] = set()
    for _, _, value, separator in _secret_arguments(command):
        if separator in value:
            values.add(value)
            if separator == '=':
                values.update(part.partition('=')[2].strip() for part in value.split(';') if '=' in part)
            else:
                values.add(value.partition(':')[2])
    return sorted(values - {''}, key=len, reverse=True)


def _strip_secret_arguments(text: str) -> str:
    parts, cursor = [], 0
    for token, prefix, value, separator in _secret_arguments(text):
        if separator in value:
            parts += [text[cursor:token.start()], f'{prefix}{REDACTED}']
            cursor = token.end()
    return ''.join(parts) + text[cursor:]


def environment_secrets(env: Mapping[str, str]) -> list[str]:
    """Values of secret-named environment variables, such as an `*_AUTH_TOKEN`, longest first."""
    values = {value for name, value in env.items() if _SECRET_NAME_RE.search(name) and len(value) >= _MIN_LITERAL_SECRET}
    return sorted(values, key=len, reverse=True)


def _strip_url(match: re.Match[str]) -> str:
    url = _USER_INFO.sub(rf'\1{REDACTED}@', match.group(0))
    head, mark, query = url.partition('?')
    if not mark:
        return url
    names = [name for name, _ in _QUERY_PAIR.findall(query)]
    signed = any(_SIGNING_PARAM.match(name) for name in names)

    def strip_pair(pair: re.Match[str]) -> str:
        name = pair.group(1)
        return f'{name}={REDACTED}' if signed or _SECRET_NAME_RE.search(name) else pair.group(0)

    return f'{head}?{_QUERY_PAIR_TEXT.sub(strip_pair, query)}'


def _strip_named(match: re.Match[str]) -> str:
    name, separator, value = match.groups()
    quote = value[0] if value[:1] in ('"', "'") else ''
    bare = value[1:].removesuffix(quote) if quote else value
    return match.group(0) if bare == REDACTED else f'{name}{separator}{quote}{REDACTED}{quote}'


def _block_end(text: str, start: int) -> int:
    depth, in_string, escaped = 0, False, False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            escaped, in_string = (False, True) if escaped else (char == '\\', char != '"')
        elif char == '"':
            in_string = True
        elif char in '[{':
            depth += 1
        elif char in ']}':
            depth -= 1
            if depth == 0:
                return index + 1
    return len(text)


def _strip_cookie_values(text: str) -> str:
    parts, cursor = [], 0
    for match in _COOKIE_BLOCK.finditer(text):
        if match.start() < cursor:
            continue
        end = _block_end(text, match.end() - 1)
        block = _JSON_VALUE.sub(lambda value: f'{value.group(1)}{REDACTED}{value.group(2)}', text[match.end():end])
        parts += [text[cursor:match.end()], block]
        cursor = end
    return ''.join(parts) + text[cursor:]


def strip_secrets(text: str, literals: Iterable[str] = ()) -> str:
    """`text` with cookies, `Authorization` headers, tokens, session ids and signed URLs replaced by `[redacted]` (ADR 0085)."""
    for literal in literals:
        text = text.replace(literal, REDACTED)
        text = text.replace(literal.replace('\n', '\n[stderr] '), REDACTED)
    text = _strip_secret_arguments(text)
    text = _URL.sub(_strip_url, text)
    text = _QUOTED_COOKIE_HEADER.sub(lambda match: f'{match.group(1)}{match.group(2)}{REDACTED}{match.group(1)}', text)
    text = _HEADER_LINE.sub(lambda match: f'{match.group(1)}{REDACTED}', text)
    text = _AUTH_SCHEME.sub(lambda match: f'{match.group(1)} {REDACTED}', text)
    text = _JWT.sub(REDACTED, text)
    text = _strip_cookie_values(text)
    return _NAMED_VALUE.sub(_strip_named, text)
