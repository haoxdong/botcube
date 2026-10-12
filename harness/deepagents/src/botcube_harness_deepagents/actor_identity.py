from __future__ import annotations

import re
from hashlib import sha256

ANONYMOUS_ACTOR_ID = 'anonymous'

_ACTOR_PATH_SEGMENT_MAX_LENGTH = 128
_ACTOR_ID_INVALID_RE = re.compile(r'[^a-z0-9_:-]+')
_ACTOR_ID_SEPARATOR_RE = re.compile(r'_+')
# The characters a sanitized id may begin or end with that it must not.
_ACTOR_ID_EDGE_CHARS = '_:-'


def _sanitize(raw: str) -> str:
    sanitized = _ACTOR_ID_INVALID_RE.sub('_', raw.lower())
    return _ACTOR_ID_SEPARATOR_RE.sub('_', sanitized).strip(_ACTOR_ID_EDGE_CHARS)


def sanitize_actor_id(value: str) -> str:
    raw = value.strip()
    if not raw:
        return ANONYMOUS_ACTOR_ID
    return _sanitize(raw)[:_ACTOR_PATH_SEGMENT_MAX_LENGTH] or ANONYMOUS_ACTOR_ID


def actor_path_segment(value: str) -> str:
    raw = value.strip()
    if not raw:
        return ANONYMOUS_ACTOR_ID
    sanitized = _sanitize(raw)
    digest = sha256(raw.encode()).hexdigest()
    if not sanitized:
        return f'actor_{digest}'
    if sanitized == raw and len(sanitized) <= _ACTOR_PATH_SEGMENT_MAX_LENGTH:
        return sanitized
    # A sanitized id never starts with an edge character, so the prefix is never empty.
    prefix = sanitized[: _ACTOR_PATH_SEGMENT_MAX_LENGTH - len(digest) - 1].rstrip(_ACTOR_ID_EDGE_CHARS)
    return f'{prefix}_{digest}'


def actor_namespace(actor_id: str, kind: str = '') -> str:
    """Where AgentCore files the actor's long-term records, or one kind of them (ADR 0033).

    The trailing slash keeps one actor's prefix from reaching an actor whose ID extends it.
    """
    return f'/actors/{actor_id}/{kind}/' if kind else f'/actors/{actor_id}/'
