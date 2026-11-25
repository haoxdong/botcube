from __future__ import annotations

import ast
from pathlib import Path

import pytest
from ag_ui.core import RunAgentInput

from botcube_harness_deepagents.invocation import (
    InvalidBinding,
    InvalidInvocation,
    Invocation,
)


def parse(props: object = None) -> Invocation:
    return Invocation.parse(RunAgentInput.model_validate({
        'threadId': 'session-1', 'runId': 'turn-1', 'messages': [],
        'tools': [], 'context': [], 'state': {}, 'forwardedProps': props,
    }))


@pytest.mark.parametrize('props', [None, {}])
def test_omitted_props_have_defaults(props: object) -> None:
    invocation = parse(props)
    assert invocation.options.model_dump() == {
        'session_user_id': None, 'warmup': False, 'preparation_scope': None, 'steering': False,
        'withdraw_steering': None, 'stop': False, 'agent_system_prompt': None, 'bot_system_prompt': None,
        'bot_memory': True, 'opening': False, 'opening_first_name': None, 'model': None, 'effort': None,
        'scheduled_run': False, 'session_snapshot_epoch': None, 'timezone': None, 'started_at': None,
        'worklog_clock': 0, 'env': None, 'credential_service_url': None, 'legacy_credential_token': None,
        'user_token': None, 'traffic': None,
    }
    assert invocation.agent_computer_cdp_url is None
    assert invocation.turn_identity is None
    assert invocation.documents is None
    assert invocation.files is None
    assert invocation.redaction_environment == {}


@pytest.mark.parametrize(('key', 'value'), [
    ('sessionUserId', 42), ('warmup', 'false'), ('preparationScope', 'unknown'), ('steering', 1),
    ('withdrawSteering', []), ('stop', 'true'), ('agentSystemPrompt', {}), ('botSystemPrompt', False),
    ('botMemory', 'false'), ('opening', 1), ('openingFirstName', 42), ('opening_first_name', []),
    ('model', []), ('effort', 42), ('effort', 'unknown'), ('scheduledRun', 'false'),
    ('timezone', 'Unknown/Zone'), ('turnStartedAt', 'yesterday'), ('turn_started_at', 42),
    ('worklogClock', 2), ('worklog_clock', True), ('env', {'NAME': 123}), ('credentialServiceUrl', {}),
    ('credentialServiceInvocationToken', False), ('userToken', []), ('traffic', 1),
])
def test_malformed_props_name_the_field_without_echoing_values(key: str, value: object) -> None:
    with pytest.raises(InvalidInvocation, match=rf'forwardedProps\.{key}\b'):
        parse({key: value})


@pytest.mark.parametrize(('props', 'code', 'message'), [
    ({'agentIdentity': [], 'soul': 'Soul'}, 'INVALID_AGENT_DOCUMENTS', 'Agent Identity'),
    ({'agentIdentity': {}, 'soul': []}, 'INVALID_AGENT_DOCUMENTS', 'Agent Identity'),
    ({'agentIdentity': {'name': 'A', 'character': '', 'vibe': '', 'avatar': ''}, 'soul': []}, 'INVALID_AGENT_DOCUMENTS', 'Soul'),
    ({'files': []}, 'INVALID_FILES', 'Files'),
    ({'agentComputerCdpUrl': ''}, 'INTERNAL_ERROR', 'agentComputerCdpUrl'),
    ({'turnIdentity': {}}, 'TURN_IDENTITY_REJECTED', 'Turn credentials'),
    ({'turnIdentity': 'malformed'}, 'TURN_IDENTITY_REJECTED', 'JWT'),
    ({'turnIdentity': 'e30.e30.signature'}, 'TURN_IDENTITY_REJECTED', 'session tags'),
])
def test_malformed_bindings_retain_their_error_types(
    props: dict[str, object], code: str, message: str,
) -> None:
    with pytest.raises(InvalidBinding, match=message) as error:
        parse(props)
    assert error.value.code == code


@pytest.mark.parametrize('props', ['opaque', [], False])
def test_props_must_be_an_object(props: object) -> None:
    with pytest.raises(InvalidInvocation, match='forwardedProps must be an object'):
        parse(props)


@pytest.mark.parametrize(('start', 'clock', 'name'), [
    ('turnStartedAt', 'worklogClock', 'openingFirstName'),
    ('turn_started_at', 'worklog_clock', 'opening_first_name'),
])
def test_wire_aliases_survive_the_sdk_copy(start: str, clock: str, name: str) -> None:
    invocation = parse({start: '2026-11-24T00:00:00Z', clock: 1, name: 'Ada', 'opening': True})
    copied = invocation.model_copy(update={'forwarded_props': {}})
    assert copied.options.started_at == 1795478400000
    assert copied.options.worklog_clock == 1
    assert copied.options.opening_first_name == 'Ada'
    assert copied.options.opening


def test_chat_services_stamp_takes_precedence_over_the_legacy_key() -> None:
    invocation = parse({'turn_started_at': '2026-11-23T00:00:00Z', 'turnStartedAt': '2026-11-24T00:00:00Z'})
    assert invocation.options.started_at == 1795478400000


@pytest.mark.parametrize('value', ['legacy-epoch', {'epoch': '1'}, {'epoch': 1, 'turnId': 'turn-1'}])
def test_unusable_snapshot_proof_cannot_authorize_reuse(value: object) -> None:
    assert parse({'sessionSnapshotEpoch': value}).options.session_snapshot_epoch is None


def test_zero_explicitly_disables_the_canonical_worklog_clock() -> None:
    assert parse({'worklog_clock': 0}).options.worklog_clock == 0


def test_sdk_payload_keeps_extensions_and_omits_private_bindings() -> None:
    invocation = parse({
        'sessionUserId': 'user-1', 'userToken': 'user-token',
        'credentialServiceInvocationToken': 'legacy-token', 'agentComputerCdpUrl': 'ws://computer',
        'streamSubgraphs': False, 'model': 'astra',
    })

    assert invocation.model_dump(by_alias=True)['forwardedProps'] == {'streamSubgraphs': False, 'model': 'astra'}
    assert invocation.options.session_user_id == 'user-1'
    assert invocation.options.user_token == 'user-token'
    assert invocation.options.legacy_credential_token == 'legacy-token'
    assert invocation.agent_computer_cdp_url == 'ws://computer'


def test_only_the_invocation_parser_reads_raw_forwarded_props() -> None:
    source = Path(__file__).resolve().parents[1] / 'src' / 'botcube_harness_deepagents'
    readers = set()
    for path in source.rglob('*.py'):
        tree = ast.parse(path.read_text())
        if any(
            isinstance(node, ast.Attribute) and node.attr == 'forwarded_props'
            or isinstance(node, ast.Constant) and node.value in ('forwardedProps', 'forwarded_props')
            for node in ast.walk(tree)
        ):
            readers.add(path.relative_to(source).as_posix())
    assert readers == {'invocation.py'}
