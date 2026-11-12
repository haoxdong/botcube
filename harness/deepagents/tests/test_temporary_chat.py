from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from pydantic import Field

from botcube_harness_deepagents import serving
from test_history_compaction import _history
from test_serving import _said, _ScriptedModel, _Service
from test_serving import service as service


def _turn(service: _Service, messages: list[dict[str, str]], **props: Any) -> list[dict[str, Any]]:
    return service.post({
        'threadId': 'temporary-chat', 'runId': f'run-{len(service.recorder.prompts)}',
        'messages': messages, 'tools': [], 'context': [], 'state': {},
        'forwardedProps': {'temporary': True, **props},
    })


def test_temporary_chat_uses_only_browser_context_without_a_user_or_persistent_backend(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(serving, 'AGENTCORE_MEMORY_ID', 'configured-production-memory')
    first = {'id': 'first', 'role': 'user', 'content': 'first question'}
    assert _said(_turn(service, [first])) == 'Echo: first question'
    second = {'id': 'second', 'role': 'user', 'content': 'second question'}
    _turn(service, [first, {'id': 'answer', 'role': 'assistant', 'content': 'first answer'}, second])
    assert service.recorder.heard[-1] == ['first question', 'second question']
    _turn(service, [second])
    assert service.recorder.heard[-1] == ['second question']
    assert service.prepared == []
    assert list(service.home.iterdir()) == []
    assert serving._AGENTS == {}
    assert serving._BACKENDS == {}
    assert serving._CHECKPOINTER is None
    assert serving._STORE is None
    forbidden = {'memory', 'session_search', 'propose_scheduled_task', 'edit_soul', 'edit_agent_identity', 'Artifact', 'execute'}
    assert all(not forbidden.intersection(tools) for tools in service.recorder.tools)


def test_temporary_chat_refuses_user_credentials_files_and_memory_identity(service: _Service) -> None:
    for field in ('sessionUserId', 'turnIdentity', 'files', 'agentComputerCdpUrl', 'credentialServiceInvocationToken'):
        events = _turn(service, [{'id': 'question', 'role': 'user', 'content': 'hello'}], **{field: 'not-allowed'})
        assert any(event['type'] == 'RUN_ERROR' and event['code'] == 'INVALID_TEMPORARY_CHAT' for event in events)
    assert service.recorder.builds == []


def test_temporary_tool_files_exist_only_in_the_current_invocations_memory(service: _Service) -> None:
    written = _turn(service, [{'id': 'write', 'role': 'user', 'content': 'write: /scratch.txt: private scratch'}])
    assert not any(event['type'] == 'RUN_ERROR' for event in written)
    read = _turn(service, [{'id': 'read', 'role': 'user', 'content': 'read: /scratch.txt'}])
    assert 'private scratch' not in _said(read)
    assert 'not found' in _said(read).lower()
    assert service.prepared == []
    assert list(service.home.iterdir()) == []


def test_long_temporary_context_compacts_without_writing_a_transcript_to_disk(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    model = _CompactingModel(recorder=service.recorder)
    monkeypatch.setattr(serving, 'build_model', lambda **_kwargs: model)
    messages = [{'id': str(message.id), 'role': 'user' if message.type == 'human' else 'assistant',
                 'content': str(message.content)} for message in _history()]
    messages.append({'id': 'latest', 'role': 'user', 'content': 'Reply OK.'})
    events = _turn(service, messages)
    service.fed()
    assert [event for event in events if event['type'] == 'RUN_ERROR'] == []
    assert model.summaries == [True]
    assert list(service.home.rglob('*')) == []
    assert service.prepared == []


class _CompactingModel(_ScriptedModel):
    summaries: list[bool] = Field(default_factory=list)

    def _generate(self, *_args: Any, **_kwargs: Any) -> ChatResult:
        self.summaries.append(True)
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content='Earlier copper questions.'))])


    def _stream(self, messages: list[BaseMessage], *args: Any, run_manager: Any = None, **kwargs: Any) -> Iterator[ChatGenerationChunk]:
        if messages and 'Context Extraction Assistant' in str(messages[0].content):
            self.summaries.append(True)
            yield ChatGenerationChunk(message=AIMessageChunk(content='Earlier copper questions.'))
        else:
            yield from super()._stream(messages, *args, run_manager=run_manager, **kwargs)


def test_temporary_workspace_preparation_never_runs_filesystem_io_on_the_event_loop(
    service: _Service, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import asyncio

    workspace = serving._workspace

    def guarded_workspace():
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return workspace()
        raise RuntimeError('Workspace I/O ran on the event loop')

    monkeypatch.setattr(serving, '_workspace', guarded_workspace)
    events = _turn(service, [{'id': 'question', 'role': 'user', 'content': 'hello'}])
    assert [event for event in events if event['type'] == 'RUN_ERROR'] == []
    assert _said(events) == 'Echo: hello'
