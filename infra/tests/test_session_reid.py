from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import session_reid as reid
from botocore.exceptions import ClientError
from types_boto3_dynamodb.service_resource import Table


class Memory:
    def __init__(self) -> None:
        self.events: dict[tuple[str, str], int] = {}

    def list_sessions(self, *, actorId: str, **_kwargs: Any) -> dict[str, Any]:
        return {'sessionSummaries': [{'sessionId': session} for actor, session in self.events if actor == actorId]}

    def list_events(self, *, actorId: str, sessionId: str, **_kwargs: Any) -> dict[str, Any]:
        return {'events': [{}] * self.events.get((actorId, sessionId), 0)}


def seed(table: Table, memory: Memory) -> None:
    for index in range(3):
        old = f'00000000-0000-4000-8000-00000000000{index}'
        for side in ('a', 'b'):
            owner, filing = f'{side}{index}', f'filing-{side}{index}'
            item = {'pk': f'SESSIONS#{owner}', 'sk': f'SESSION#{old}', 'session_id': old,
                    'filing_user_id': filing, 'title': 'preserve this title', 'ttl': 1_900_000_000,
                    'runtime_binding': f'runtime-{side}{index}', 'runtime_generation': 'tracked-v1'}
            table.put_item(Item=item)
            table.put_item(Item={**item, 'sk': 'MAIN'})
            if side == 'b':
                memory.events[filing, old] = 7


def manifest(table: Table, memory: Memory) -> dict[str, Any]:
    return reid.plan(reid.scan(table), memory, table=table.name, memory='memory', region='us-east-1',
                     decision_repository='owner/project', decision_item=1)


def approved(plan: dict[str, Any], saved: dict[str, Any], operation: str = 'apply') -> dict[str, Any]:
    return {'migration': 'session-reid', 'operation': operation, 'manifest_sha256': reid.digest(plan),
            'backup_sha256': reid.digest(saved), 'decision_url': 'https://github.com/owner/project/issues/1#issuecomment-1',
            **dict.fromkeys(reid.ATTESTATIONS, True)}


def get(table: Table, pk: str, sk: str) -> dict[str, Any]:
    response = table.get_item(Key={'pk': pk, 'sk': sk})
    assert 'Item' in response
    return response['Item']


def test_reids_only_empty_chats_preserves_main_history_metadata_and_can_restore(chat_table: Table) -> None:
    memory = Memory()
    seed(chat_table, memory)
    original = reid.scan(chat_table)
    plan = manifest(chat_table, memory)
    assert len(plan['reids']) == 3 and not plan['blockers']
    assert {row['owner'] for row in plan['reids']} == {'a0', 'a1', 'a2'}
    assert reid.scan(chat_table) == original
    saved = reid.backup(plan, chat_table, memory)
    reid.execute(plan, saved, approved(plan, saved), chat_table, memory)
    reid.execute(plan, saved, approved(plan, saved), chat_table, memory)
    for row in plan['reids']:
        session = get(chat_table, f"SESSIONS#{row['owner']}", f"SESSION#{row['new']}")
        main = get(chat_table, session['pk'], 'MAIN')
        assert session['filing_user_id'] == row['filing_user_id']
        assert session['title'] == 'preserve this title' and session['ttl'] == 1_900_000_000
        assert main['session_id'] == row['new']
        assert 'Item' not in chat_table.get_item(Key={'pk': session['pk'], 'sk': f"SESSION#{row['old']}"})
    kept = [item for item in reid.scan(chat_table) if item['pk'].startswith('SESSIONS#b')]
    assert kept == [item for item in original if item['pk'].startswith('SESSIONS#b')]
    assert sorted(memory.events.values()) == [7, 7, 7]
    reid.execute(plan, saved, approved(plan, saved, 'rollback'), chat_table, memory, rollback=True)
    assert reid.scan(chat_table) == original


@pytest.mark.parametrize('fault', ['pending-writes', 'dispatch', 'computer', 'scheduled', 'running', 'fenced', 'writer', 'retired-main'])
def test_manifest_blocks_unsafe_or_unsupported_reference_instead_of_losing_it(chat_table: Table, fault: str) -> None:
    memory = Memory()
    seed(chat_table, memory)
    old = '00000000-0000-4000-8000-000000000000'
    if fault == 'pending-writes':
        memory.events['filing-a0', 'lgw-db8055e0e0307d5a016bec4dc338d698-checkpoint'] = 1
    elif fault in ('running', 'fenced'):
        field = 'turn_running_since' if fault == 'running' else 'deleted_at'
        chat_table.update_item(Key={'pk': 'SESSIONS#a0', 'sk': f'SESSION#{old}'},
                               UpdateExpression=f'SET {field} = :value', ExpressionAttributeValues={':value': 'date'})
    else:
        records = {
            'dispatch': {'pk': 'DISPATCH#["filing-a0","' + old + '"]', 'sk': 'token', 'session_id': old},
            'computer': {'pk': 'AGENT_COMPUTER_RUNNING', 'sk': f'a0#{old}', 'record': {'accountId': 'a0', 'threadId': old}},
            'scheduled': {'pk': 'SESSIONS#a0', 'sk': 'SCHEDULED_DELIVERY#d', 'sideChat': old},
            'writer': {'pk': 'WRITERS#["filing-a0","' + old + '"]', 'sk': 'CONTROL', 'runtime_writers': 1},
            'retired-main': {'pk': 'SESSIONS#retired-a0', 'sk': 'MAIN', 'session_id': old, 'filing_user_id': 'filing-a0'},
        }
        chat_table.put_item(Item=records[fault])
    original = reid.scan(chat_table)
    plan = manifest(chat_table, memory)
    assert len(plan['blockers']) == 1
    with pytest.raises(RuntimeError, match='blocked'):
        reid.backup(plan, chat_table, memory)
    assert reid.scan(chat_table) == original


def test_moves_activity_and_settled_writer_keys_without_changing_expiry(chat_table: Table) -> None:
    memory = Memory()
    seed(chat_table, memory)
    old = '00000000-0000-4000-8000-000000000000'
    chat_table.put_item(Item={'pk': 'TURN_SUMMARIES#filing-a0', 'sk': f'SESSION#{old}#TURN#message',
                             'session_id': old, 'summary': 'preserve summary', 'ttl': 123})
    chat_table.put_item(Item={'pk': 'WRITERS#["filing-a0","' + old + '"]', 'sk': 'CONTROL', 'runtime_writers': 0})
    chat_table.put_item(Item={'pk': 'AGENT_COMPUTER#a0', 'sk': f'SCREENSHOT#{old}', 'screenshot': 'preserve pixels'})
    chat_table.put_item(Item={'pk': 'AGENT_COMPUTER#b0', 'sk': f'SCREENSHOT#{old}', 'screenshot': 'keep original key'})
    plan = manifest(chat_table, memory)
    saved = reid.backup(plan, chat_table, memory)
    reid.execute(plan, saved, approved(plan, saved), chat_table, memory)
    new = next(row['new'] for row in plan['reids'] if row['owner'] == 'a0')
    assert get(chat_table, 'TURN_SUMMARIES#filing-a0', f'SESSION#{new}#TURN#message') == {
        'pk': 'TURN_SUMMARIES#filing-a0', 'sk': f'SESSION#{new}#TURN#message',
        'session_id': new, 'summary': 'preserve summary', 'ttl': 123,
    }
    assert get(chat_table, 'WRITERS#["filing-a0","' + new + '"]', 'CONTROL')['runtime_writers'] == 0
    assert get(chat_table, 'AGENT_COMPUTER#a0', f'SCREENSHOT#{new}')['screenshot'] == 'preserve pixels'
    assert get(chat_table, 'AGENT_COMPUTER#b0', f'SCREENSHOT#{old}')['screenshot'] == 'keep original key'


@pytest.mark.parametrize('fault', ['approval', 'backup', 'inventory', 'memory', 'restore-proof'])
def test_refuses_execution_when_reviewed_inputs_or_state_change(chat_table: Table, fault: str) -> None:
    memory = Memory()
    seed(chat_table, memory)
    plan = manifest(chat_table, memory)
    saved = reid.backup(plan, chat_table, memory)
    approval = approved(plan, saved)
    if fault == 'approval':
        approval['manifest_sha256'] = 'different'
    elif fault == 'backup':
        saved['changes'] = []
    elif fault == 'inventory':
        chat_table.update_item(Key={'pk': 'SESSIONS#a0', 'sk': 'MAIN'}, UpdateExpression='SET extra = :x',
                               ExpressionAttributeValues={':x': 'new field'})
    elif fault == 'memory':
        row = plan['reids'][0]
        memory.events[row['filing_user_id'], row['old']] = 1
    else:
        approval['backup_restore_verified'] = False
    original = reid.scan(chat_table)
    with pytest.raises(RuntimeError):
        reid.execute(plan, saved, approval, chat_table, memory)
    assert reid.scan(chat_table) == original


def test_backup_is_private_exclusive_and_round_trips_before_images(chat_table: Table, tmp_path: Path) -> None:
    memory = Memory()
    seed(chat_table, memory)
    plan = manifest(chat_table, memory)
    saved = reid.backup(plan, chat_table, memory)
    path = tmp_path / 'backup.json'
    reid.save_private(path, saved)
    assert path.stat().st_mode & 0o777 == 0o600
    assert reid.read_json(path) == saved
    assert reid.digest(reid.read_json(path)) == reid.digest(saved)
    with pytest.raises(FileExistsError):
        reid.save_private(path, saved)


def test_changed_collision_scope_requires_a_new_decision(chat_table: Table) -> None:
    memory = Memory()
    seed(chat_table, memory)
    chat_table.delete_item(Key={'pk': 'SESSIONS#a0', 'sk': 'SESSION#00000000-0000-4000-8000-000000000000'})
    with pytest.raises(RuntimeError, match='scope'):
        manifest(chat_table, memory)


def test_rollback_refuses_to_erase_a_new_metadata_field(chat_table: Table) -> None:
    memory = Memory()
    seed(chat_table, memory)
    plan = manifest(chat_table, memory)
    saved = reid.backup(plan, chat_table, memory)
    reid.execute(plan, saved, approved(plan, saved), chat_table, memory)
    row = plan['reids'][0]
    chat_table.update_item(Key={'pk': f"SESSIONS#{row['owner']}", 'sk': f"SESSION#{row['new']}"},
                           UpdateExpression='SET new_field = :x', ExpressionAttributeValues={':x': 'must survive'})
    original = reid.scan(chat_table)
    with pytest.raises(RuntimeError, match='Source changed'):
        reid.execute(plan, saved, approved(plan, saved, 'rollback'), chat_table, memory, rollback=True)
    assert reid.scan(chat_table) == original


def test_only_exact_missing_actor_is_an_absence_proof() -> None:
    class MissingActor(Memory):
        message = 'Actor actor not found'

        def list_sessions(self, **_kwargs: Any) -> dict[str, Any]:
            raise ClientError({'Error': {'Code': 'ResourceNotFoundException', 'Message': self.message}}, 'ListSessions')

    memory = MissingActor()
    assert reid.empty_memory(memory, 'memory', 'actor', 'session')['actor_absent'] is True
    memory.message = 'Memory memory not found'
    with pytest.raises(ClientError):
        reid.empty_memory(memory, 'memory', 'actor', 'session')


@pytest.mark.parametrize('reference', ['dispatch', 'writer', 'scheduled', 'computer'])
def test_rollback_refuses_new_references_even_without_new_history(chat_table: Table, reference: str) -> None:
    memory = Memory()
    seed(chat_table, memory)
    plan = manifest(chat_table, memory)
    saved = reid.backup(plan, chat_table, memory)
    reid.execute(plan, saved, approved(plan, saved), chat_table, memory)
    row = plan['reids'][0]
    owner, new, filing = row['owner'], row['new'], row['filing_user_id']
    records = {
        'dispatch': {'pk': f'DISPATCH#["{filing}","{new}"]', 'sk': 'token', 'session_id': new},
        'writer': {'pk': f'WRITERS#["{filing}","{new}"]', 'sk': 'CONTROL', 'runtime_writers': 1},
        'scheduled': {'pk': f'SESSIONS#{owner}', 'sk': 'SCHEDULED_DELIVERY#d', 'sideChat': new},
        'computer': {'pk': 'AGENT_COMPUTER_RUNNING', 'sk': f'{owner}#{new}', 'record': {'accountId': owner, 'threadId': new}},
    }
    chat_table.put_item(Item=records[reference])
    original = reid.scan(chat_table)
    with pytest.raises(RuntimeError, match='Reference inventory changed'):
        reid.execute(plan, saved, approved(plan, saved, 'rollback'), chat_table, memory, rollback=True)
    assert reid.scan(chat_table) == original


def test_refuses_a_manifest_or_approval_that_names_another_migration_or_decision(chat_table: Table) -> None:
    memory = Memory()
    seed(chat_table, memory)
    plan = manifest(chat_table, memory)
    saved = reid.backup(plan, chat_table, memory)
    unmarked = {name: value for name, value in plan.items() if name != 'migration'}
    with pytest.raises(RuntimeError, match='outside the approved scope'):
        reid.changes(unmarked)
    original = reid.scan(chat_table)
    with pytest.raises(RuntimeError, match='Operator approval does not name'):
        reid.execute(plan, saved, {**approved(plan, saved), 'migration': 'other'}, chat_table, memory)
    elsewhere = {**approved(plan, saved), 'decision_url': 'https://github.com/owner/project/issues/2#issuecomment-1'}
    with pytest.raises(RuntimeError, match='must cite the migration decision'):
        reid.execute(plan, saved, elsewhere, chat_table, memory)
    assert reid.scan(chat_table) == original
