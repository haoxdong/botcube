from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from hashlib import sha256
from typing import Any

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


def record_belongs_to_actor(record: Mapping[str, Any], actor_id: str) -> bool:
    return bool(actor_namespace_paths(record, actor_id))


def actor_namespace_paths(record: Mapping[str, Any], actor_id: str) -> list[str]:
    paths: list[str] = []
    for namespace in _record_namespaces(record):
        path = _actor_namespace_path(namespace, actor_id)
        if path is not None and path not in paths:
            paths.append(path)
    return paths


def _record_namespaces(record: Mapping[str, Any]) -> list[str]:
    namespaces: list[str] = []
    namespace = record.get('namespace')
    if isinstance(namespace, str):
        namespaces.append(namespace)
    raw_namespaces = record.get('namespaces')
    if (
        isinstance(raw_namespaces, Sequence)
        and not isinstance(raw_namespaces, str | bytes | bytearray)
    ):
        namespaces.extend(ns for ns in raw_namespaces if isinstance(ns, str))
    return namespaces


def _actor_namespace_path(namespace: str, actor_id: str) -> str | None:
    segments = [part for part in namespace.split('/') if part]
    for index, segment in enumerate(segments[:-1]):
        if segment in {'actor', 'actors'} and segments[index + 1] == actor_id:
            return '/' + '/'.join(segments[:index + 2]) + '/'
    return None
