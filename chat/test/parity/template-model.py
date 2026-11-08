from __future__ import annotations

import json
import re
from collections.abc import Iterator, Sequence
from typing import Any

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


class TemplateModel(BaseChatModel):
    @property
    def _llm_type(self) -> str:
        return 'template-test'

    def _generate(self, *_args: Any, **_kwargs: Any) -> ChatResult:
        raise AssertionError('The Harness must stream')

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> TemplateModel:
        return self

    def _stream(self, messages: list[BaseMessage], *_args: Any, **_kwargs: Any) -> Iterator[ChatGenerationChunk]:
        request_index = next(index for index in range(len(messages) - 1, -1, -1) if isinstance(messages[index], HumanMessage))
        request = messages[request_index]
        results = [message for message in messages[request_index + 1:] if isinstance(message, ToolMessage)]
        if str(request.content) == 'Schedule a template data read.':
            if results:
                yield ChatGenerationChunk(message=AIMessageChunk(content='Confirm the template data schedule.'))
            else:
                call = tool_call_chunk(name='propose_scheduled_task', args='', id=f'{request.id}-template-schedule', index=0)
                yield ChatGenerationChunk(message=AIMessageChunk(content='', tool_call_chunks=[call]))
                arguments = json.dumps({
                    'title': 'Template data', 'prompt': 'Read the template site data.', 'frequency': 'daily', 'time': '09:00',
                })
                yield ChatGenerationChunk(message=AIMessageChunk(content='', tool_call_chunks=[
                    tool_call_chunk(args=arguments, index=0),
                ]))
            return
        if not results:
            paths = re.findall(r'(/skills/[^\s<>`\"]+/SKILL\.md)', str(messages[0].content))
            if len(set(paths)) != 1:
                raise AssertionError(f'Expected one loaded template skill, found {paths}')
            name, arguments = 'read_file', {'file_path': paths[0]}
        elif len(results) == 1:
            commands = re.findall(r'run `([^`]+)`', str(results[0].content))
            if len(commands) != 1:
                raise AssertionError('The loaded skill must specify one command')
            name, arguments = 'execute', {'command': commands[0]}
        else:
            yield ChatGenerationChunk(message=AIMessageChunk(content=f'Template data: {results[-1].content}'))
            return
        call = tool_call_chunk(name=name, args=json.dumps(arguments), id=f'{request.id}-template-{len(results)}', index=0)
        yield ChatGenerationChunk(message=AIMessageChunk(content='', tool_call_chunks=[call]))


def build_model(**_kwargs: Any) -> TemplateModel:
    return TemplateModel()


serving.build_model = build_model
serving.main()
