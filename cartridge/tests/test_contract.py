from dataclasses import replace

from botcube_cartridge import InvocationAuth, ModelRelay


def test_invocation_binding_preserves_the_turn_relay() -> None:
    relay = ModelRelay('http://credentials.test/openai/v1', 'turn-token', {'X-Session-Id': 'session-one'}, 'session-one')
    auth = InvocationAuth('account-one', False, {'CLI_TOKEN': 'turn-token'}, relay)
    assert auth.model_relay is not None
    assert auth.model_relay is relay
    assert auth.model_relay.session_id == 'session-one'
    renewed = replace(auth, model_relay=replace(relay, token='renewed-token'))
    assert renewed.model_relay is not None
    assert renewed.model_relay.token == 'renewed-token'
    assert auth.model_relay.token == 'turn-token'


def test_invocations_without_plan_usage_need_no_relay() -> None:
    assert InvocationAuth('account-one', True, None).model_relay is None
