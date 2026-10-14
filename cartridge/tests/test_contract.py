from dataclasses import replace
from pathlib import Path

from botcube_cartridge import (
    InvocationAuth,
    ModelRelay,
    environment_cache_key,
    filing_user_id,
    install_skill,
)


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


def test_per_turn_values_leave_the_cache_key() -> None:
    key = environment_cache_key('CLI_TOKEN')
    turn = {'ACCOUNT': 'account-one', 'CLI_TOKEN': 'turn-token'}
    renewed = {**turn, 'CLI_TOKEN': 'renewed-token'}
    assert key(turn) == key(renewed) == (('ACCOUNT', 'account-one'),)
    assert key({**turn, 'ACCOUNT': 'account-two'}) != key(turn)
    assert key(None) == ()


def test_filing_user_id_matches_the_chat_service() -> None:
    # Values from the Chat Service half, botcube/chat/src/filing-user-id.test.ts.
    assert filing_user_id('template', 'acct_tëst12345') == 'template_616363745f74c3ab73743132333435'
    assert filing_user_id('template', 'acct_' + 'x' * 200) == (
        'template_sha256_e34fa6ccd28671839789d00d5e97d09261afc9fe39da608bb3991a6eb080d51d'
    )
    assert filing_user_id('template', 'acct/a') != filing_user_id('template', 'acct_a')


def test_a_skill_is_installed_under_the_named_skills_directory(tmp_path: Path) -> None:
    source = tmp_path / 'package' / 'SKILL.md'
    source.parent.mkdir()
    source.write_text('# Skill')
    root = tmp_path / 'root'

    install_skill(root, '/tools/skills/', 'site', source)

    assert (root / 'tools/skills/site/SKILL.md').read_text() == '# Skill'


def test_a_root_already_holding_the_skill_keeps_it(tmp_path: Path) -> None:
    source = tmp_path / 'skills' / 'site' / 'SKILL.md'
    source.parent.mkdir(parents=True)
    source.write_text('# Checkout')

    install_skill(tmp_path, 'skills', 'site', source)

    assert source.read_text() == '# Checkout'
