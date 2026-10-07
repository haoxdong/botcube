"""AgentCoreMemorySaver that reads DeltaChannel history in one bulk pass.

Copied from open PR langchain-ai/langchain-aws#1237 (head cebc843). Drop this
module and use `AgentCoreMemorySaver` directly once a `langgraph-checkpoint-aws`
release includes that PR; keep the local additions: `delta_channel_history`
(which the Turn saver walks with its buffered checkpoints), `adelete_session`, and the
Session's messages snapshot.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import asdict
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from langchain_core.runnables import RunnableConfig, run_in_executor
from langgraph.checkpoint.base import CheckpointTuple, get_checkpoint_id
from langgraph_checkpoint_aws import AgentCoreMemorySaver
from langgraph_checkpoint_aws.checkpoint.agentcore.helpers import EventType
from langgraph_checkpoint_aws.checkpoint.agentcore.models import CheckpointerConfig

from ...messages_snapshot import MessagesSnapshot
from .purge import _pace, purge_session

if TYPE_CHECKING:
    from langgraph.checkpoint.base import DeltaChannelHistory


class OnePassAgentCoreMemorySaver(AgentCoreMemorySaver):
    def get_delta_channel_history(
        self, *, config: RunnableConfig, channels: Sequence[str]
    ) -> Mapping[str, DeltaChannelHistory]:
        """Replay the base parent-chain walk over bulk-paged events.

        The base implementation issues one `get_tuple` (one full ListEvents
        pass) per ancestor checkpoint; this pages the thread's events once and
        stops as soon as every channel is seeded.
        """
        if not channels:
            return {}
        return self.delta_channel_history(
            config=config, channels=channels, target=self.get_tuple(config), known={}
        )

    def delta_channel_history(
        self,
        *,
        config: RunnableConfig,
        channels: Sequence[str],
        target: CheckpointTuple | None,
        known: Mapping[str, CheckpointTuple],
    ) -> dict[str, DeltaChannelHistory]:
        """Walk `target`'s ancestors over `known` checkpoints (they win), then over
        the record's events, paged once until the walk completes."""
        result, complete = _replay_delta_channel_history(target, {**known}, channels)
        if complete:
            return result
        checkpoint_config = CheckpointerConfig.from_runnable_config(dict(config))
        all_events: list[EventType] = []
        for page in self._iter_event_pages(checkpoint_config):
            all_events.extend(page)
            persisted = self._tuples_by_checkpoint_id(all_events, checkpoint_config)
            result, complete = _replay_delta_channel_history(target, {**persisted, **known}, channels)
            if complete:
                break
        return result

    async def aget_delta_channel_history(
        self, *, config: RunnableConfig, channels: Sequence[str]
    ) -> Mapping[str, DeltaChannelHistory]:
        return await run_in_executor(
            None, self.get_delta_channel_history, config=config, channels=channels
        )

    async def adelete_session(self, user_id: str, session_id: str) -> None:
        """Delete every event of the user's Session and of its messages snapshot, paced to AgentCore's delete rate."""
        await asyncio.to_thread(purge_session, self, user_id, session_id)
        await asyncio.to_thread(purge_session, self, user_id, _messages_session(session_id))

    async def aread_messages_snapshot(self, user_id: str, session_id: str) -> MessagesSnapshot | None:
        return await asyncio.to_thread(self._read_messages_snapshot, user_id, session_id)

    async def awrite_messages_snapshot(self, user_id: str, session_id: str, snapshot: MessagesSnapshot) -> None:
        await asyncio.to_thread(self._write_messages_snapshot, user_id, session_id, snapshot)

    def _read_messages_snapshot(self, user_id: str, session_id: str) -> MessagesSnapshot | None:
        for _ in range(3):
            events = list(self._messages_events(user_id, session_id, payloads=True))
            newest = max((event for event in events if _snapshot_kind(event) != 'fragment'), key=_snapshot_order, default=None)
            if newest is None:
                return None
            payload = _snapshot_payload(newest, events)
            if payload is not None:
                return MessagesSnapshot(**json.loads(''.join(item['blob'] for item in payload)))
        raise RuntimeError('Messages snapshot remained incomplete after three reads')

    def _write_messages_snapshot(self, user_id: str, session_id: str, snapshot: MessagesSnapshot) -> None:
        """Add the snapshot in its own session beside the record, then delete the copies it supersedes."""
        serialized = json.dumps(asdict(snapshot), ensure_ascii=True)
        payload = [{'blob': serialized[start:start + _MESSAGE_BYTES]} for start in range(0, len(serialized), _MESSAGE_BYTES)]
        fragments: list[str] = []
        try:
            if len(payload) > _EVENT_ITEMS:
                for start in range(0, len(payload), _EVENT_ITEMS):
                    fragment = self._create_messages_event(user_id, session_id, snapshot.checkpoint, payload[start:start + _EVENT_ITEMS], 'fragment')
                    fragments.append(fragment['eventId'])
                payload = [{'blob': json.dumps(fragments)}]
            written = self._create_messages_event(user_id, session_id, snapshot.checkpoint, payload, 'manifest' if fragments else None)
        except Exception:
            self._delete_messages_events(user_id, session_id, fragments)
            raise
        self._delete_messages_events(user_id, session_id, self._superseded_messages_events(user_id, session_id, written))

    def _superseded_messages_events(self, user_id: str, session_id: str, written: dict[str, Any]) -> list[str]:
        superseded = [
            event for event in self._messages_events(user_id, session_id, payloads=False)
            if _snapshot_kind(event) != 'fragment' and _snapshot_order(event) < _snapshot_order(written)
        ]
        obsolete: list[str] = []
        manifests: set[str] = set()
        for event in superseded:
            obsolete.append(event['eventId'])
            if _snapshot_kind(event) == 'manifest':
                manifests.add(event['eventId'])
        if manifests:
            for event in self._messages_events(user_id, session_id, payloads=True):
                if event['eventId'] in manifests:
                    obsolete.extend(_fragment_ids(event))
        return obsolete

    def _create_messages_event(
        self, user_id: str, session_id: str, checkpoint: str, payload: list[dict[str, str]], kind: str | None
    ) -> dict[str, Any]:
        event_client = self.checkpoint_event_client
        metadata = {_CHECKPOINT: {'stringValue': checkpoint}}
        if kind is not None:
            metadata[_SNAPSHOT_KIND] = {'stringValue': kind}
        return event_client.client.create_event(
            memoryId=event_client.memory_id,
            actorId=user_id,
            sessionId=_messages_session(session_id),
            eventTimestamp=datetime.now(UTC),
            payload=payload,
            metadata=metadata,
        )['event']

    def _delete_messages_events(self, user_id: str, session_id: str, event_ids: Sequence[str]) -> None:
        event_client = self.checkpoint_event_client
        for event_id in event_ids:
            # Within DeleteEvent's limits, shared with purges.
            _pace()
            event_client.client.delete_event(
                memoryId=event_client.memory_id,
                actorId=user_id,
                sessionId=_messages_session(session_id),
                eventId=event_id,
            )

    def _messages_events(self, user_id: str, session_id: str, *, payloads: bool) -> Iterator[dict[str, Any]]:
        event_client = self.checkpoint_event_client
        params: dict[str, Any] = {
            'memoryId': event_client.memory_id,
            'actorId': user_id,
            'sessionId': _messages_session(session_id),
            'maxResults': 100,
            'includePayloads': payloads,
        }
        while True:
            response = event_client.client.list_events(**params)
            yield from response['events']
            if 'nextToken' not in response:
                return
            params['nextToken'] = response['nextToken']

    def _iter_event_pages(self, checkpoint_config: CheckpointerConfig) -> Iterator[list[EventType]]:
        """Yield decoded events page by page, with no total item cap."""
        event_client = self.checkpoint_event_client
        params: dict[str, Any] = {
            'memoryId': event_client.memory_id,
            'actorId': checkpoint_config.actor_id,
            'sessionId': checkpoint_config.session_id,
            'maxResults': self.max_results,
            'includePayloads': True,
        }
        while True:
            response = event_client.client.list_events(**params)
            yield [
                event_client.serializer.deserialize_event(item['blob'])
                for event in response['events']
                for item in event['payload']
                if item.get('blob')
            ]
            if 'nextToken' not in response:
                return
            params['nextToken'] = response['nextToken']

    def _tuples_by_checkpoint_id(
        self, events: Sequence[EventType], checkpoint_config: CheckpointerConfig
    ) -> dict[str, CheckpointTuple]:
        checkpoints, writes_by_checkpoint, channel_data = self.processor.process_events(
            list(events)
        )
        return {
            checkpoint_id: self.processor.build_checkpoint_tuple(
                checkpoint_event,
                writes_by_checkpoint.get(checkpoint_id, []),
                channel_data,
                checkpoint_config,
            )
            for checkpoint_id, checkpoint_event in checkpoints.items()
        }


# The snapshot's own session sits beside the Session's record, so reading the Session's state never lists it.
_MESSAGES_SESSION_SUFFIX = '-messages'
# CreateEvent allows 100 KB per message; ASCII JSON makes character and byte offsets equal.
_MESSAGE_BYTES = 100_000
# ASCII payloads can double when escaped on the wire; leave room for the event envelope below 10 MB.
_EVENT_ITEMS = 10_000_000 // (2 * _MESSAGE_BYTES) - 1
_SNAPSHOT_KIND = 'snapshot_kind'
# Each snapshot event names the checkpoint it was taken at, so a write finds the copies it supersedes without their payloads.
_CHECKPOINT = 'checkpoint'


def _snapshot_kind(event: dict[str, Any]) -> str | None:
    return event['metadata'].get(_SNAPSHOT_KIND, {}).get('stringValue')


def _snapshot_order(event: dict[str, Any]) -> tuple[str, datetime, str]:
    return _snapshot_checkpoint(event), event['eventTimestamp'], event['eventId']


def _fragment_ids(event: dict[str, Any]) -> list[str]:
    return json.loads(''.join(item['blob'] for item in event['payload']))


def _messages_session(session_id: str) -> str:
    return session_id + _MESSAGES_SESSION_SUFFIX


def _snapshot_checkpoint(event: Mapping[str, Any]) -> str:
    return event['metadata'][_CHECKPOINT]['stringValue']


def _replay_delta_channel_history(
    target_tuple: CheckpointTuple | None,
    tuples_by_id: dict[str | None, CheckpointTuple],
    channels: Sequence[str],
) -> tuple[dict[str, DeltaChannelHistory], bool]:
    """Mirror `BaseCheckpointSaver.get_delta_channel_history` over known tuples.

    Ancestors are looked up by `parent_config` id, never by event order, so
    forked threads only contribute on-path writes. Returns the result and
    whether the walk finished rather than stalling on an unfetched ancestor.
    """
    collected_by_ch: dict[str, list[tuple[str, str, Any]]] = {c: [] for c in channels}
    seed_by_ch: dict[str, Any] = {}
    remaining = set(channels)
    cursor_config = target_tuple.parent_config if target_tuple else None

    while cursor_config is not None and remaining:
        tup = tuples_by_id.get(get_checkpoint_id(cursor_config))
        if tup is None:
            return _delta_channel_histories(channels, collected_by_ch, seed_by_ch), False
        _collect_ancestor(tup, remaining, collected_by_ch, seed_by_ch)
        cursor_config = tup.parent_config

    return _delta_channel_histories(channels, collected_by_ch, seed_by_ch), True


def _collect_ancestor(
    tup: CheckpointTuple,
    remaining: set[str],
    collected_by_ch: dict[str, list[tuple[str, str, Any]]],
    seed_by_ch: dict[str, Any],
) -> None:
    """Collect one ancestor's writes, and seed each channel its snapshot holds."""
    for write in reversed(tup.pending_writes or []):
        if write[1] in remaining:
            collected_by_ch[write[1]].append(write)
    for ch in list(remaining):
        if ch in tup.checkpoint['channel_values']:
            seed_by_ch[ch] = tup.checkpoint['channel_values'][ch]
            remaining.discard(ch)


def _delta_channel_histories(
    channels: Sequence[str],
    collected_by_ch: dict[str, list[tuple[str, str, Any]]],
    seed_by_ch: dict[str, Any],
) -> dict[str, DeltaChannelHistory]:
    result: dict[str, DeltaChannelHistory] = {}
    for ch in channels:
        entry: DeltaChannelHistory = {'writes': list(reversed(collected_by_ch[ch]))}
        if ch in seed_by_ch:
            entry['seed'] = seed_by_ch[ch]
        result[ch] = entry
    return result


def _snapshot_payload(newest: dict[str, Any], events: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
    if _snapshot_kind(newest) != 'manifest':
        return newest['payload']
    indexed = {event['eventId']: event for event in events}
    fragments = _fragment_ids(newest)
    if any(event_id not in indexed for event_id in fragments):
        return None
    return [item for event_id in fragments for item in indexed[event_id]['payload']]
