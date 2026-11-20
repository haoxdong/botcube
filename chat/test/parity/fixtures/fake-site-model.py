"""The Harness serving the fake site's definition with a scripted model: it reads the fake site skill, runs its CLI and schedules it."""
from __future__ import annotations

import json
import re
from collections.abc import Iterator, Sequence
from typing import Any

from fake_site_harness import FAKE_SITE_DEFINITION
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessageChunk,
    BaseMessage,
    HumanMessage,
    ToolMessage,
)
from langchain_core.messages.tool import tool_call_chunk
from langchain_core.outputs import ChatGenerationChunk, ChatResult

from botcube_harness_deepagents import serving


class FakeSiteModel(BaseChatModel):
    @property
    def _llm_type(self) -> str:
        return 'fake-site-test'

    def _generate(self, *_args: Any, **_kwargs: Any) -> ChatResult:
        raise AssertionError('The Harness must stream')

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> FakeSiteModel:
        return self

    def _stream(self, messages: list[BaseMessage], *_args: Any, **_kwargs: Any) -> Iterator[ChatGenerationChunk]:
        request_index = next(index for index in range(len(messages) - 1, -1, -1) if isinstance(messages[index], HumanMessage))
        request = messages[request_index]
        results = [message for message in messages[request_index + 1:] if isinstance(message, ToolMessage)]
        if str(request.content) == 'Schedule a fake site data read.':
            if results:
                yield ChatGenerationChunk(message=AIMessageChunk(content='Confirm the fake site data schedule.'))
            else:
                call = tool_call_chunk(name='propose_scheduled_task', args='', id=f'{request.id}-fake-site-schedule', index=0)
                yield ChatGenerationChunk(message=AIMessageChunk(content='', tool_call_chunks=[call]))
                arguments = json.dumps({
                    'title': 'Fake site data', 'prompt': 'Read the fake site data.', 'frequency': 'daily', 'time': '09:00',
                })
                yield ChatGenerationChunk(message=AIMessageChunk(content='', tool_call_chunks=[
                    tool_call_chunk(args=arguments, index=0),
                ]))
            return
        if not results:
            paths = re.findall(r'(/skills/[^\s<>`\"]+/SKILL\.md)', str(messages[0].content))
            if len(set(paths)) != 1:
                raise AssertionError(f'Expected one loaded fake site skill, found {paths}')
            name, arguments = 'read_file', {'file_path': paths[0]}
        elif len(results) == 1:
            commands = re.findall(r'run `([^`]+)`', str(results[0].content))
            if len(commands) != 1:
                raise AssertionError('The loaded skill must specify one command')
            name, arguments = 'execute', {'command': commands[0]}
        else:
            yield ChatGenerationChunk(message=AIMessageChunk(content=f'Fake site data: {results[-1].content}'))
            return
        call = tool_call_chunk(name=name, args=json.dumps(arguments), id=f'{request.id}-fake-site-{len(results)}', index=0)
        yield ChatGenerationChunk(message=AIMessageChunk(content='', tool_call_chunks=[call]))


def build_model(**_kwargs: Any) -> FakeSiteModel:
    return FakeSiteModel()


serving.configure_harness_definition(FAKE_SITE_DEFINITION)
async def answer_nothing(_model: Any, _text: str) -> None:
    """The snapshot build answers once through the model's HTTP client; this scripted model has none."""


serving.build_model = build_model
serving.answer_once = answer_nothing
serving.main()
