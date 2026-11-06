from __future__ import annotations

import json
from typing import Any

from langchain_aws import ChatBedrockConverse
from pydantic import SecretStr


class DelegatingBedrockClient:
    def __init__(self, *, helper: str = 'general-purpose', multiplier: int = 1) -> None:
        self.helper = helper
        self.multiplier = multiplier
        self.requests: list[dict[str, Any]] = []
        self.fail_at: int | None = None
        self.failure: BaseException = RuntimeError('fake provider failure')

    def converse(self, **kwargs: Any) -> dict[str, Any]:
        self.requests.append(kwargs)
        if self.fail_at is not None and len(self.requests) >= self.fail_at:
            raise self.failure
        step = (len(self.requests) - 1) % 3
        content: list[dict[str, Any]] = [{'text': 'Checked.' if step == 1 else 'The helper checked the result.'}]
        if step == 0:
            content = [{'toolUse': {'toolUseId': f'delegate-{len(self.requests)}', 'name': 'task', 'input': {
                'description': 'Check the result.', 'subagent_type': self.helper,
            }}}]
        return {
            'output': {'message': {'role': 'assistant', 'content': content}},
            'stopReason': 'tool_use' if step == 0 else 'end_turn',
            'usage': {'inputTokens': 40 * self.multiplier, 'outputTokens': 10 * self.multiplier,
                      'totalTokens': 110 * self.multiplier, 'cacheReadInputTokens': 40 * self.multiplier,
                      'cacheWriteInputTokens': 20 * self.multiplier},
            'metrics': {'latencyMs': 1},
        }

    def converse_stream(self, **kwargs: Any) -> dict[str, Any]:
        response = self.converse(**kwargs)
        [block] = response['output']['message']['content']
        events: list[dict[str, Any]] = [{'messageStart': {'role': 'assistant'}}]
        if 'toolUse' in block:
            tool = block['toolUse']
            events.extend([
                {'contentBlockStart': {'contentBlockIndex': 0, 'start': {'toolUse': {
                    'toolUseId': tool['toolUseId'], 'name': tool['name'],
                }}}},
                {'contentBlockDelta': {'contentBlockIndex': 0, 'delta': {
                    'toolUse': {'input': json.dumps(tool['input'])},
                }}},
            ])
        else:
            events.append({'contentBlockDelta': {'contentBlockIndex': 0, 'delta': block}})
        events.extend([
            {'contentBlockStop': {'contentBlockIndex': 0}},
            {'messageStop': {'stopReason': response['stopReason']}},
            {'metadata': {'usage': response['usage'], 'metrics': response['metrics']}},
        ])
        return {'stream': iter(events)}


def fake_bedrock_model(client: DelegatingBedrockClient, model_id: str = 'us.anthropic.claude-sonnet-4-6', *, streaming: bool = False) -> ChatBedrockConverse:
    return ChatBedrockConverse(
        model=model_id, region_name='us-east-1', disable_streaming=not streaming,
        aws_access_key_id=SecretStr('test'), aws_secret_access_key=SecretStr('test'), client=client,
    )
