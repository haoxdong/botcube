"""The Harness serving the fake site's definition with a scripted model that drives the computer's browser to the fake site."""
from __future__ import annotations

import json
import re
from collections.abc import Iterator, Sequence
from dataclasses import replace
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
from botcube_harness_deepagents.definition import InvocationAuth
from botcube_harness_deepagents.invocation import Invocation

_environment: dict[str, str] = {}


def prepare_invocation(input_data: Invocation, token: str | None) -> InvocationAuth:
    auth = FAKE_SITE_DEFINITION.prepare_invocation(input_data, token)
    _environment.clear()
    _environment.update(auth.environment or {})
    if (cdp := input_data.agent_computer_cdp_url) is not None:
        _environment['AGENT_BROWSER_CDP'] = cdp
    return auth


class ComputerModel(BaseChatModel):
    @property
    def _llm_type(self) -> str:
        return 'fake-site-computer-test'

    def _generate(self, *_args: Any, **_kwargs: Any) -> ChatResult:
        raise AssertionError('The Harness must stream')

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> ComputerModel:
        return self

    def _stream(self, messages: list[BaseMessage], *_args: Any, **_kwargs: Any) -> Iterator[ChatGenerationChunk]:
        request = next(message.content for message in reversed(messages) if isinstance(message, HumanMessage))
        private_value = {
            'Report the private CDP URL.': 'AGENT_BROWSER_CDP',
            'Report the private site invocation.': 'FAKE_SITE_CREDENTIAL_INVOCATION',
        }.get(str(request))
        if private_value:
            yield ChatGenerationChunk(message=AIMessageChunk(content=_environment[private_value]))
            return
        results = [message for message in messages if isinstance(message, ToolMessage)]
        if not results:
            paths = re.findall(r'(/skills/[^\s<>`\"]+/SKILL\.md)', str(messages[0].content))
            if len(set(paths)) != 1:
                raise AssertionError('Expected one fake site skill')
            name, arguments = 'read_file', {'file_path': paths[0]}
        elif len(results) == 1:
            if 'agent-browser get url' not in str(results[0].content):
                raise AssertionError('The fake site skill does not expose the browser tool')
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
            if heading != 'Fake site':
                raise AssertionError(f'The actual browser tool read an unexpected heading: {heading}')
            yield ChatGenerationChunk(message=AIMessageChunk(content=f'Computer opened {url}\nHeading: {heading}'))
            return
        call = tool_call_chunk(name=name, args=json.dumps(arguments), id=f'computer-{len(results)}', index=0)
        yield ChatGenerationChunk(message=AIMessageChunk(content='', tool_call_chunks=[call]))


def build_model(**_kwargs: Any) -> ComputerModel:
    return ComputerModel()


serving.configure_harness_definition(replace(FAKE_SITE_DEFINITION, prepare_invocation=prepare_invocation))
async def answer_nothing(_model: Any, _text: str) -> None:
    """The snapshot build answers once through the model's HTTP client; this scripted model has none."""


serving.build_model = build_model
serving.answer_once = answer_nothing
serving.main()
