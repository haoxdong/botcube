"""The fake site's Bedrock Converse stand-in for the Chat Service's turn summaries (local/stand-ins/fake_site.py)."""

import httpx
import pytest

from local_stand_in_support import running_fake_site

# Runs a real subprocess, server or socket (ADR 0083 decision 1).
pytestmark = pytest.mark.integration


def test_local_summary_uses_converse_and_rejects_unsupported_tools() -> None:
    with running_fake_site() as site:
        url = f'http://127.0.0.1:{site.server_port}/model/local/converse'
        response = httpx.post(url, json={'toolConfig': {'toolChoice': {'tool': {'name': 'turn_summary'}}}})
        assert response.status_code == 200
        assert response.json() == {
            'output': {'message': {'role': 'assistant', 'content': [{'toolUse': {
                'toolUseId': 'local-summary', 'name': 'turn_summary',
                'input': {'title': 'Answered a question', 'summary': 'Replied to the user'},
            }}]}},
            'stopReason': 'tool_use',
        }
        unsupported = httpx.post(url, json={'toolConfig': {'toolChoice': {'tool': {'name': 'other'}}}})
        assert unsupported.status_code == 400
        assert unsupported.json() == {'error': 'Only turn_summary is supported'}
        malformed = httpx.post(url, content='not json')
        assert malformed.status_code == 400
        assert malformed.json() == {'error': 'Invalid Converse request'}
