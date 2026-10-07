from __future__ import annotations

import pytest

from botcube_harness_deepagents.actor_identity import (
    actor_namespace_paths,
    actor_path_segment,
    record_belongs_to_actor,
    sanitize_actor_id,
)


@pytest.mark.parametrize(
    ('value', 'expected'),
    [
        ('  ', 'anonymous'),
        ('Thread 1', 'thread_1'),
        ('__a  b..c__', 'a_b_c'),
        (':-thread-1:-', 'thread-1'),
        ('!!!', 'anonymous'),
        ('a' * 200, 'a' * 128),
    ],
)
def test_a_conversation_id_becomes_a_bounded_path_safe_name(value: str, expected: str) -> None:
    assert sanitize_actor_id(value) == expected


@pytest.mark.parametrize(
    ('value', 'expected'),
    [
        (' ', 'anonymous'),
        ('cartridge_616e6f6e', 'cartridge_616e6f6e'),
        ('a' * 128, 'a' * 128),
        # A changed or shortened id carries the digest of the raw id, so two ids never share a segment.
        ('Alice', 'alice_3bc51062973c458d5a6f2d8d64a023246354ad7e064b1e4e009ec8a0699a3043'),
        ('!!!', 'actor_e84c538e7fe250730ef62de220c40dfa808d3008c0cdb437181564b88b8714b8'),
        ('a' * 200, 'a' * 63 + '_c2a908d98f5df987ade41b5fce213067efbcc21ef2240212a41e54b5e7c28ae5'),
        (
            'A' * 62 + ' ' + 'b' * 10,
            'a' * 62 + '_4bd87ff5f18dd6b5b54e497348bc66cfc52649a3683ac8d14cad3d2e4b33b9ad',
        ),
    ],
)
def test_an_actor_id_becomes_a_collision_safe_path_segment(value: str, expected: str) -> None:
    assert actor_path_segment(value) == expected


def test_a_record_belongs_to_the_actor_its_namespaces_name() -> None:
    record = {
        'namespace': '/strategy/actor/user-1/facts',
        'namespaces': ['/strategy/actors/user-1', '/strategy/actor/user-1/facts', '/strategy/actors/user-2'],
    }

    assert actor_namespace_paths(record, 'user-1') == ['/strategy/actor/user-1/', '/strategy/actors/user-1/']
    assert record_belongs_to_actor(record, 'user-2')
    assert not record_belongs_to_actor(record, 'user-3')
