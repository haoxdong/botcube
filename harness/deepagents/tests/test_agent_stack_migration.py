from __future__ import annotations

from typing import Any

import pytest

import test_serving as runtime
from botcube_harness_deepagents import serving
from test_serving import _Service
from test_serving import service as service


@pytest.mark.parametrize('memory', [False, True])
@pytest.mark.parametrize('documents', [False, True])
def test_generic_prompt_survives_every_model_request_and_saved_history(
    service: _Service, memory: bool, documents: bool,
) -> None:
    props: dict[str, Any] = dict(runtime.DOCUMENTS) if documents else {}
    events = service.turn('narrated work', memory=memory, **props)

    assert len(service.recorder.prompts) == 3
    for prompt in service.recorder.prompts:
        assert prompt.startswith(serving.AGENT_SYSTEM_PROMPT)
        assert ('<soul>' in prompt) is documents
        assert '<memory_guidelines>' not in prompt
    ordered = [
        (event['type'], event.get('delta') or event.get('toolCallName') or event.get('content'))
        for event in events if event['type'] in {'TEXT_MESSAGE_CONTENT', 'TOOL_CALL_START', 'TOOL_CALL_RESULT'}
    ]
    assert ordered == [
        ('TEXT_MESSAGE_CONTENT', 'I will check the first result.'),
        ('TOOL_CALL_START', 'execute'),
        ('TOOL_CALL_RESULT', 'step-1\n\n[Command succeeded with exit code 0]'),
        ('TEXT_MESSAGE_CONTENT', 'I checked it and will verify the second result.'),
        ('TOOL_CALL_START', 'execute'),
        ('TOOL_CALL_RESULT', 'step-2\n\n[Command succeeded with exit code 0]'),
        ('TEXT_MESSAGE_CONTENT', 'Both checks finished.'),
    ]
    assert events[-1]['type'] == 'RUN_FINISHED'
    assert runtime._replay('user-1', 'thread-1') == [
        ('user', 'narrated work'),
        ('assistant', 'I will check the first result.'),
        ('tool', 'step-1\n\n[Command succeeded with exit code 0]'),
        ('assistant', 'I checked it and will verify the second result.'),
        ('tool', 'step-2\n\n[Command succeeded with exit code 0]'),
        ('assistant', 'Both checks finished.'),
    ]
    assert all('delete' in tools and 'write_todos' not in tools for tools in service.recorder.tools)
