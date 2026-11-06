from __future__ import annotations

ANONYMOUS_ACTOR_ID = 'anonymous'


def actor_namespace(actor_id: str, kind: str = '') -> str:
    """Where AgentCore files the actor's long-term records, or one kind of them (ADR 0033).

    The trailing slash keeps one actor's prefix from reaching an actor whose ID extends it.
    """
    return f'/actors/{actor_id}/{kind}/' if kind else f'/actors/{actor_id}/'
