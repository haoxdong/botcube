from __future__ import annotations

import importlib.util
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from prompt_cache_fake import DelegatingBedrockClient


class BedrockProbe(DelegatingBedrockClient):
    def __init__(self, failure: str = '') -> None:
        super().__init__()
        self.failure_mode = failure
        self.stream_models: list[str] = []

    def converse_stream(self, **kwargs: Any) -> dict[str, Any]:
        self.stream_models.append(kwargs['modelId'])

        def events() -> Iterator[dict[str, Any]]:
            yield {'messageStart': {'role': 'assistant'}}
            if self.failure_mode != 'empty':
                if self.failure_mode == 'refused':
                    raise RuntimeError('AccessDeniedException: model is not available')
                yield {'contentBlockDelta': {'contentBlockIndex': 0, 'delta': {'text': 'OK'}}}
                if self.failure_mode == 'partial':
                    raise RuntimeError('stream interrupted')
            yield {'messageStop': {'stopReason': 'end_turn'}}

        return {'stream': events()}


def run_checker(monkeypatch: pytest.MonkeyPatch, provider: BedrockProbe, configured: str | None = None) -> int:
    import functools

    import boto3

    from botcube_harness_deepagents import aws_clients

    monkeypatch.setenv('AWS_ACCESS_KEY_ID', 'test')
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'test')
    monkeypatch.setenv('AWS_REGION', 'us-east-1')
    if configured is None:
        monkeypatch.delenv('BOTCUBE_MODEL', raising=False)
    else:
        monkeypatch.setenv('BOTCUBE_MODEL', configured)
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: provider)
    monkeypatch.setattr(boto3.session.Session, 'client', lambda *args, **kwargs: provider)
    # A new checker process builds its own shared Bedrock clients, which later tests must not see.
    monkeypatch.setattr(aws_clients, 'bedrock', functools.cache(aws_clients.bedrock.__wrapped__))
    path = Path(__file__).resolve().parents[4] / 'scripts' / 'check_prompt_caching.py'
    spec = importlib.util.spec_from_file_location('check_prompt_caching', path)
    assert spec is not None and spec.loader is not None
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    return checker.main()


@pytest.mark.parametrize(('configured', 'expected'), [
    (None, 'us.anthropic.claude-sonnet-4-6'),
    ('opus-5.5', 'us.anthropic.claude-opus-5-5'),
])
def test_checker_invokes_the_working_default(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], configured: str | None, expected: str,
) -> None:
    provider = BedrockProbe()
    assert run_checker(monkeypatch, provider, configured) == 0
    assert provider.stream_models == [expected]
    assert 'PASS|default:invoke|' in capsys.readouterr().out


@pytest.mark.parametrize('failure', ['refused', 'partial', 'empty'])
def test_checker_fails_on_an_unusable_default_response(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], failure: str,
) -> None:
    provider = BedrockProbe(failure)
    assert run_checker(monkeypatch, provider) == 1
    output = capsys.readouterr().out
    assert provider.stream_models == ['us.anthropic.claude-sonnet-4-6']
    assert 'FAIL|default:invoke|' in output
    assert 'PASS|default:invoke|' not in output
