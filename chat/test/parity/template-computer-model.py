from __future__ import annotations

import json
import re
from collections.abc import Iterator, Sequence
from dataclasses import replace
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

from botcube_always_on.harness import CARTRIDGE, InvocationAuth
from botcube_harness_deepagents import serving

_environment: dict[str, str] = {}


def prepare_invocation(input_data: Any) -> InvocationAuth:
    auth = CARTRIDGE.prepare_invocation(input_data)
    _environment.clear()
    _environment.update(auth.environment or {})
    _environment['AGENT_BROWSER_CDP'] = input_data.forwarded_props['agentComputerCdpUrl']
    return auth


class ComputerModel(BaseChatModel):
    @property
    def _llm_type(self) -> str:
        return 'template-computer-test'

    def _generate(self, *_args: Any, **_kwargs: Any) -> ChatResult:
        raise AssertionError('The Harness must stream')

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> ComputerModel:
        return self

    def _stream(self, messages: list[BaseMessage], *_args: Any, **_kwargs: Any) -> Iterator[ChatGenerationChunk]:
        request = next(message.content for message in reversed(messages) if isinstance(message, HumanMessage))
        private_value = {
            'Report the private CDP URL.': 'AGENT_BROWSER_CDP',
            'Report the private site invocation.': 'TEMPLATE_CREDENTIAL_INVOCATION',
        }.get(str(request))
        if private_value:
            yield ChatGenerationChunk(message=AIMessageChunk(content=_environment[private_value]))
            return
        results = [message for message in messages if isinstance(message, ToolMessage)]
        if not results:
            paths = re.findall(r'(/skills/[^\s<>`\"]+/SKILL\.md)', str(messages[0].content))
            if len(set(paths)) != 1:
                raise AssertionError('Expected one packaged template skill')
            name, arguments = 'read_file', {'file_path': paths[0]}
        elif len(results) == 1:
            if 'agent-browser get url' not in str(results[0].content):
                raise AssertionError('The packaged skill does not expose the browser tool')
            name, arguments = 'execute', {'command': 'agent-browser get url'}
        elif len(results) == 2:
            url = str(results[-1].content).strip().splitlines()[0]
            if not url.startswith('http://127.0.0.1:') or not url.endswith('/login'):
                raise AssertionError(f'The actual browser tool did not read the fake site URL: {results[-1].content}')
            name, arguments = 'execute', {'command': f'agent-browser open {url}'}
        elif len(results) == 3:
            name, arguments = 'execute', {'command': 'agent-browser get text h1'}
        else:
            url = str(results[1].content).strip().splitlines()[0]
            heading = str(results[-1].content).strip().splitlines()[0]
            if heading != 'Template site':
                raise AssertionError(f'The actual browser tool read an unexpected heading: {heading}')
            yield ChatGenerationChunk(message=AIMessageChunk(content=f'Computer opened {url}\nHeading: {heading}'))
            return
        call = tool_call_chunk(name=name, args=json.dumps(arguments), id=f'computer-{len(results)}', index=0)
        yield ChatGenerationChunk(message=AIMessageChunk(content='', tool_call_chunks=[call]))


def build_model(**_kwargs: Any) -> ComputerModel:
    return ComputerModel()


serving.configure_harness_definition(replace(CARTRIDGE, prepare_invocation=prepare_invocation))
serving.build_model = build_model
serving.main()
