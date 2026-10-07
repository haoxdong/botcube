from pathlib import Path

import pytest

from botcube_harness_deepagents._env import positive_float, positive_int


def test_positive_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('BOTCUBE_TEST_LIMIT', '7')
    assert positive_int('BOTCUBE_TEST_LIMIT', 5) == 7
    monkeypatch.setenv('BOTCUBE_TEST_LIMIT', '0.5')
    assert positive_float('BOTCUBE_TEST_LIMIT', 5.0) == 0.5


@pytest.mark.parametrize('value', ['0', '-1', 'NaN', 'Infinity'])
def test_invalid_setting(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv('BOTCUBE_TEST_LIMIT', value)
    with pytest.raises(ValueError):
        positive_int('BOTCUBE_TEST_LIMIT', 5)
    with pytest.raises(ValueError):
        positive_float('BOTCUBE_TEST_LIMIT', 5.0)


def test_memory_path_setting(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from botcube_harness_deepagents.memory_files import build_memory_sources

    configured = tmp_path / 'configured' / 'memory.md'
    explicit = tmp_path / 'explicit' / 'memory.md'
    monkeypatch.setenv('BOTCUBE_MEMORY_PATH', str(configured))
    assert build_memory_sources() == [str(configured)]
    assert configured.read_text() == ''
    assert build_memory_sources(memory_path=explicit) == [str(explicit)]
    assert explicit.read_text() == ''


@pytest.mark.parametrize('setting', ['OPENAI_API_BASE', 'OPENAI_BASE_URL'])
def test_openai_sdk_endpoint_setting(monkeypatch: pytest.MonkeyPatch, setting: str) -> None:
    from botcube_harness_deepagents.llm import build_model

    monkeypatch.delenv('OPENAI_API_BASE', raising=False)
    monkeypatch.delenv('OPENAI_BASE_URL', raising=False)
    monkeypatch.setenv(setting, 'https://corporate.example/v1')
    monkeypatch.setenv('OPENAI_API_KEY', 'test-key')
    monkeypatch.setenv('BOTCUBE_OPENAI_MODEL_PREFIX', 'corporate.')
    model = build_model(model='openai:approved-model')
    assert str(model.root_client.base_url) == 'https://corporate.example/v1/'
    assert str(model.root_async_client.base_url) == 'https://corporate.example/v1/'
    assert model.model_name == 'corporate.approved-model'
