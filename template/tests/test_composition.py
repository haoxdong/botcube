import asyncio
import json
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from botcube_template.harness import CARTRIDGE as HARNESS_CARTRIDGE


def test_template_harness_exposes_safe_tool_commands(tmp_path: Path) -> None:
    assert HARNESS_CARTRIDGE.command_validator('echo hello') is None
    assert HARNESS_CARTRIDGE.command_validator('printf hello') == 'Only echo, template-cli data, or the documented agent-browser commands are allowed'
    assert HARNESS_CARTRIDGE.command_validator('echo hello; whoami') == 'Shell operators are not allowed'
    assert HARNESS_CARTRIDGE.command_validator('echo hello\nwhoami') == 'Shell operators are not allowed'
    assert HARNESS_CARTRIDGE.command_validator('echo hello\rwhoami') == 'Shell operators are not allowed'
    assert HARNESS_CARTRIDGE.command_validator('template-cli data') is None
    assert HARNESS_CARTRIDGE.command_validator('template-cli login') == 'Only echo, template-cli data, or the documented agent-browser commands are allowed'
    HARNESS_CARTRIDGE.prepare_root(tmp_path)
    assert 'template-cli data' in (tmp_path / 'skills' / 'template' / 'SKILL.md').read_text()


def test_deepagents_harness_constructs_from_the_template_cartridge(monkeypatch: pytest.MonkeyPatch) -> None:
    from botcube_harness_deepagents import serving

    monkeypatch.setattr(serving, '_cartridge', None)

    serving.configure_harness_definition(HARNESS_CARTRIDGE)
    configured = serving._require_cartridge()
    backend = configured.build_backend({})

    assert configured.agent_name == 'BotCube'
    assert tuple(configured.skills) == tuple(HARNESS_CARTRIDGE.skills)
    rejected = backend.execute('printf hello')
    assert (rejected.exit_code, rejected.output) == (126, 'Error: Only echo, template-cli data, or the documented agent-browser commands are allowed')


def test_template_deploy_identity_is_placeholder_only() -> None:
    identity = json.loads(
        (Path(__file__).resolve().parents[1] / 'deploy' / 'identity.json').read_text()
    )

    assert identity['aws']['account'] == '000000000000'
    assert identity['aws']['region'] == 'us-east-1'
    assert identity['domains']['chatService'] == 'http://localhost:8123'


def test_browser_tool_commands_use_the_filtered_computer() -> None:
    assert HARNESS_CARTRIDGE.command_validator('agent-browser get url') is None
    assert HARNESS_CARTRIDGE.command_validator('agent-browser open http://example.test/login') is None
    assert HARNESS_CARTRIDGE.command_validator('agent-browser get text h1') is None
    assert HARNESS_CARTRIDGE.command_validator('agent-browser --cdp ws://other.test get url') is not None
    assert HARNESS_CARTRIDGE.command_validator('agent-browser open file:///etc/hostname') is not None


def test_browser_tool_isolates_capabilities_and_retires_idle_daemons() -> None:
    first = HARNESS_CARTRIDGE.prepare_invocation({'threadId': 'first', 'forwardedProps': {'agentComputerCdpUrl': 'ws://chat.test/cdp?token=first'}})
    second = HARNESS_CARTRIDGE.prepare_invocation({'threadId': 'second', 'forwardedProps': {'agentComputerCdpUrl': 'ws://chat.test/cdp?token=second'}})
    renewed = HARNESS_CARTRIDGE.prepare_invocation({'threadId': 'first', 'forwardedProps': {'agentComputerCdpUrl': 'ws://chat.test/cdp?token=renewed'}})
    assert first.environment is not None
    environments = [auth.environment for auth in (first, second, renewed)]
    assert all(environment is not None for environment in environments)
    assert first.environment['AGENT_BROWSER_CDP'] == 'ws://chat.test/cdp?token=first'
    assert len({environment['AGENT_BROWSER_SESSION'] for environment in environments if environment is not None}) == 3
    assert first.environment['AGENT_BROWSER_IDLE_TIMEOUT_MS'] == '10000'


def test_rotating_browser_capabilities_reuse_the_session_agent_and_refresh_its_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    from botcube_harness_deepagents import serving

    class Backend:
        def __init__(self, environment: dict[str, str]) -> None:
            self._env = environment

        def execute(self, command: str) -> tuple[str, str]:
            return self._env['AGENT_BROWSER_CDP'], self._env['AGENT_BROWSER_SESSION']

    class Agent:
        def __init__(self, **kwargs: Any) -> None:
            pass

    monkeypatch.setattr(serving, '_cartridge', None)
    serving.configure_harness_definition(HARNESS_CARTRIDGE)
    monkeypatch.setattr(serving, '_cartridge', replace(serving._require_cartridge(), build_backend=Backend))
    for name in ('_AGENTS', '_AGENT_BACKENDS', '_BACKEND_BY_AGENT', '_BACKENDS', '_MODEL_RELAYS'):
        monkeypatch.setattr(serving, name, {})
    monkeypatch.setattr(serving, '_ensure_memory_backends', lambda: None)
    monkeypatch.setattr(serving, 'build_model', lambda **kwargs: None)
    monkeypatch.setattr(serving, 'install_prompt_cache_usage_callback', lambda model: model)
    monkeypatch.setattr(serving, 'build_agent', lambda **kwargs: SimpleNamespace(config={'recursion_limit': 10}))
    monkeypatch.setattr(serving, '_SessionAgent', Agent)

    def turn(account: str, session: str, capability: str, credential: str | None = None) -> Any:
        props = {'sessionUserId': account, 'agentComputerCdpUrl': f'ws://chat.test/cdp?token={capability}'}
        if credential is not None:
            props['credentialServiceInvocation'] = credential
        auth = HARNESS_CARTRIDGE.prepare_invocation({'threadId': session, 'forwardedProps': props})
        return serving._get_agent(actor_id=account, session_user_id=account, thread_id=session, persistent_memory=False, environment=auth.environment)

    first = turn('owner-one', 'session-one', 'first')
    renewed = turn('owner-one', 'session-one', 'renewed')
    assert renewed is first
    assert len(serving._AGENTS) == 1
    assert len(serving._BACKENDS) == 1
    latest = HARNESS_CARTRIDGE.prepare_invocation({'threadId': 'session-one', 'forwardedProps': {'agentComputerCdpUrl': 'ws://chat.test/cdp?token=renewed'}})
    assert latest.environment is not None
    assert serving._BACKEND_BY_AGENT[renewed].execute('agent-browser get url') == ('ws://chat.test/cdp?token=renewed', latest.environment['AGENT_BROWSER_SESSION'])
    other_owner = turn('owner-two', 'session-one', 'other-owner')
    other_session = turn('owner-one', 'session-two', 'other-session')
    assert other_owner is not first
    assert other_session is not first
    assert serving._BACKEND_BY_AGENT[other_owner] is not serving._BACKEND_BY_AGENT[first]
    assert serving._BACKEND_BY_AGENT[other_session] is not serving._BACKEND_BY_AGENT[first]
    credential_first = turn('owner-one', 'session-one', 'first', 'credential-first')
    credential_renewed = turn('owner-one', 'session-one', 'renewed', 'credential-renewed')
    assert credential_first is not credential_renewed
    assert serving._BACKEND_BY_AGENT[credential_renewed]._env['TEMPLATE_CREDENTIAL_INVOCATION'] == 'credential-renewed'


def test_shared_invocation_preserves_each_templates_filing_identity(monkeypatch: pytest.MonkeyPatch) -> None:
    from ag_ui.core import RunAgentInput

    from botcube_harness_deepagents import serving

    monkeypatch.setattr(serving, '_cartridge', None)
    monkeypatch.setattr(serving, 'AGENTCORE_MEMORY_ID', None)
    serving.configure_harness_definition(HARNESS_CARTRIDGE)

    async def selected_agent(input_data: Any, context: Any, forwarded: Any, auth: Any, session_user_id: str,
                             documents: Any, memory_revision: int, files: Any, warmup: Any):
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
