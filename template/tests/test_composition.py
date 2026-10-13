import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from botcube_template.harness import CARTRIDGE as HARNESS_CARTRIDGE


def test_template_harness_installs_its_skill(tmp_path: Path) -> None:
    HARNESS_CARTRIDGE.prepare_root(tmp_path)
    assert 'template-cli data' in (tmp_path / 'skills' / 'template' / 'SKILL.md').read_text()


def test_deepagents_harness_constructs_from_the_template_cartridge(monkeypatch: pytest.MonkeyPatch) -> None:
    from botcube_harness_deepagents import serving

    monkeypatch.setattr(serving, '_cartridge', None)

    serving.configure_harness_definition(HARNESS_CARTRIDGE)
    configured = serving._require_cartridge()
    configured.build_backend({})

    assert configured.agent_name == 'BotCube'
    assert tuple(configured.skills) == tuple(HARNESS_CARTRIDGE.skills)


def test_template_deploy_identity_is_placeholder_only() -> None:
    identity = json.loads(
        (Path(__file__).resolve().parents[1] / 'deploy' / 'identity.json').read_text()
    )

    assert identity['aws']['account'] == '000000000000'
    assert identity['aws']['region'] == 'us-east-1'
    assert identity['domains']['chatService'] == 'http://localhost:8123'


def test_a_rotating_site_invocation_keeps_the_sessions_agent() -> None:
    def environment(credential: str) -> Any:
        props = {'sessionUserId': 'owner-one', 'credentialServiceInvocationToken': credential}
        return HARNESS_CARTRIDGE.prepare_invocation({'threadId': 'session-one', 'forwardedProps': props}).environment

    first, renewed = environment('credential-first'), environment('credential-renewed')

    assert renewed['TEMPLATE_CREDENTIAL_INVOCATION'] == 'credential-renewed'
    assert HARNESS_CARTRIDGE.environment_cache_key(renewed) == HARNESS_CARTRIDGE.environment_cache_key(first)


def test_shared_invocation_preserves_each_templates_filing_identity(monkeypatch: pytest.MonkeyPatch) -> None:
    from ag_ui.core import RunAgentInput

    from botcube_harness_deepagents import serving

    monkeypatch.setattr(serving, '_cartridge', None)
    monkeypatch.setattr(serving, 'AGENTCORE_MEMORY_ID', None)
    serving.configure_harness_definition(HARNESS_CARTRIDGE)

    async def selected_agent(input_data: Any, context: Any, forwarded: Any, auth: Any, session_user_id: str,
                             documents: Any, files: Any, warmup: Any, turn_identity: str):
        yield (auth.actor_id, session_user_id, auth.persistent_memory)

    monkeypatch.setattr(serving, '_invoke_agent', selected_agent)

    async def invoke(owner: str | None) -> list[Any]:
        run = RunAgentInput(thread_id='shared-thread', run_id='run', messages=[], tools=[], context=[], state={},
                            forwarded_props={'sessionUserId': owner} if owner else {})
        return [event async for event in serving.invoke(run, serving._RequestContext('shared-thread'))]

    assert asyncio.run(invoke('owner-one')) == [('owner-one', 'owner-one', True)]
    assert asyncio.run(invoke('owner-two')) == [('owner-two', 'owner-two', True)]
    with pytest.raises(serving.MissingUserIdError, match='Chat Service must forward'):
        asyncio.run(invoke(None))


@pytest.mark.parametrize('forwarded', [None, {}])
def test_shared_invocation_without_template_identity_is_classified(monkeypatch: pytest.MonkeyPatch, forwarded: Any) -> None:
    from ag_ui.core import RunAgentInput

    from botcube_harness_deepagents import serving

    monkeypatch.setattr(serving, '_cartridge', None)
    serving.configure_harness_definition(HARNESS_CARTRIDGE)

    async def invoke() -> None:
        run = RunAgentInput(thread_id='thread', run_id='run', messages=[], tools=[], context=[], state={},
                            forwarded_props=forwarded)
        async for _ in serving.invoke(run, serving._RequestContext('thread')):
            pytest.fail('An invocation without identity must not run')

    with pytest.raises(serving.MissingUserIdError) as rejected:
        asyncio.run(invoke())
    assert str(rejected.value) == 'Invocation carries no user ID; the Chat Service must forward the account ID'
    assert rejected.value.code == 'MISSING_USER_ID'
