from typing import Any

import pytest
from deepagents import (
    GeneralPurposeSubagentProfile,
    HarnessProfile,
    register_harness_profile,
)
from langchain_core.messages import AIMessage

from botcube_harness_deepagents.agent import build_agent
from conftest import ToolBindableFakeMessagesModel


class ProfileModel(ToolBindableFakeMessagesModel):
    model_name: str


@pytest.mark.parametrize('settings', [
    {'general_purpose_subagent': GeneralPurposeSubagentProfile(enabled=False)},
    {'general_purpose_subagent': GeneralPurposeSubagentProfile(enabled=True)},
    {'general_purpose_subagent': GeneralPurposeSubagentProfile(description='')},
    {'general_purpose_subagent': GeneralPurposeSubagentProfile(system_prompt='')},
    {'tool_description_overrides': {'read_file': 'Custom description.'}},
])
@pytest.mark.parametrize('helper', [False, True])
def test_build_rejects_dropped_profile_settings(settings: dict[str, Any], helper: bool) -> None:
    key = f'fixture:unsupported-{helper}-{settings}'
    register_harness_profile(key, HarnessProfile(**settings))
    unsupported = ProfileModel(model_name=key, responses=[AIMessage('Unused.')])
    plain = ToolBindableFakeMessagesModel(responses=[AIMessage('Done.')])
    kwargs: dict[str, Any] = {'model': unsupported}
    if helper:
        kwargs = {'model': plain, 'subagents': [{
            'name': 'helper', 'description': 'Checks.', 'system_prompt': 'Check.', 'model': unsupported,
        }]}
    with pytest.raises(ValueError, match='Harness would drop.*' + next(iter(settings))):
        build_agent(backend=None, skills=[], **kwargs)


@pytest.mark.parametrize('helper', [False, True])
def test_build_rejects_dropped_permissions(helper: bool) -> None:
    model = ToolBindableFakeMessagesModel(responses=[AIMessage('Unused.')])
    kwargs: dict[str, Any] = {'permissions': []}
    if helper:
        kwargs = {'subagents': [{'name': 'helper', 'description': 'Checks.', 'system_prompt': 'Check.', 'permissions': []}]}
    with pytest.raises(ValueError, match='Harness would drop.*permissions'):
        build_agent(model=model, backend=None, skills=[], **kwargs)
