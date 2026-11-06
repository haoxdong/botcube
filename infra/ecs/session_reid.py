from __future__ import annotations

import hashlib
import json
import os
import re
from collections import defaultdict
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import uuid4

from boto3.dynamodb.types import TypeDeserializer, TypeSerializer
from botocore.exceptions import ClientError

Item = dict[str, Any]
SERIALIZER = TypeSerializer()
DESERIALIZER = TypeDeserializer()
# What every manifest, backup and approval of this migration names, so none from another migration is accepted.
MIGRATION = 'session-reid'
ATTESTATIONS = ('adr_0067_approved', 'admission_closed', 'old_dispatchers_retired',
                'old_runtimes_stopped', 'backup_restore_verified')


def encoded(item: Item) -> Item:
    return {name: SERIALIZER.serialize(value) for name, value in item.items()}


def decoded(item: Item) -> Item:
    return {name: DESERIALIZER.deserialize(value) for name, value in item.items()}


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def read_json(path: Path) -> Item:
    return json.loads(path.read_text())


def save_private(path: Path, value: Item) -> None:
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
        json.dump(value, output, indent=2, sort_keys=True)
        output.write('\n')


def scan(table: Any) -> list[Item]:
    items: list[Item] = []
    params: Item = {'ConsistentRead': True}
    while True:
        page = table.scan(**params)
        items.extend(page['Items'])
        if 'LastEvaluatedKey' not in page:
            return sorted(items, key=lambda item: (item['pk'], item['sk']))
        params['ExclusiveStartKey'] = page['LastEvaluatedKey']


def collisions(items: list[Item]) -> list[list[Item]]:
    groups: dict[str, list[Item]] = defaultdict(list)
    for item in items:
        if item['pk'].startswith('SESSIONS#') and item['sk'].startswith('SESSION#'):
            groups[item['session_id']].append(item)
    found = [group for _, group in sorted(groups.items())
             if len({item['filing_user_id'] for item in group}) > 1]
    if len(found) != 3 or any(len(group) != 2 for group in found):
        raise RuntimeError('Collision census differs from the approved three groups of two; review a new scope')
    return found


def strings(value: Any) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from strings(child)


def references(items: list[Item], session: Item) -> list[Item]:
    owners = history_owners(items, session)
    filing, old = session['filing_user_id'], session['session_id']
    return [item for item in items if _reference_owner(item, owners, filing, old)
            and any(old in value for value in strings(item))]


def history_owners(items: list[Item], session: Item) -> set[str]:
    return {session['pk'].removeprefix('SESSIONS#')} | {
        item['retired_id'] for item in items if item['pk'] == session['pk'] and item['sk'].startswith('RETIRED#')}


def _reference_owner(item: Item, owners: set[str], filing: str, old: str) -> bool:
    pk = item['pk']
    if pk.startswith('SESSIONS#'):
        return pk.removeprefix('SESSIONS#') in owners or (item.get('filing_user_id') == filing and item.get('session_id') == old)
    if pk.startswith('TURN_SUMMARIES#'):
        return pk == f'TURN_SUMMARIES#{filing}'
    if pk.startswith(('DISPATCH#', 'WRITERS#')):
        return pk.split('#', 1)[1] == json.dumps([filing, old], separators=(',', ':'))
    if pk == 'PURGES':
        return item.get('filing_user_id') == filing
    if pk.startswith('AGENT_COMPUTER#'):
        return pk.removeprefix('AGENT_COMPUTER#') in owners
    if pk in ('AGENT_COMPUTER_RUNNING', 'AGENT_COMPUTER_STREAM'):
        return item.get('record', {}).get('accountId') in owners
    return True


def replacement(item: Item, session: Item, new: str) -> Item:
    old, filing, pk, sk = session['session_id'], session['filing_user_id'], item['pk'], item['sk']
    result = dict(item)
    if pk == session['pk'] and sk in ('MAIN', f'SESSION#{old}'):
        if item.get('session_id') != old or item.get('filing_user_id') != filing:
            raise RuntimeError('Session/Main reference has a different filing identity')
        result['session_id'] = new
        if sk != 'MAIN':
            result['sk'] = f'SESSION#{new}'
    elif pk == f'TURN_SUMMARIES#{filing}' and sk.startswith(f'SESSION#{old}#TURN#'):
        result.update(sk=f'SESSION#{new}#TURN#{sk.split("#TURN#", 1)[1]}', session_id=new)
    elif pk == 'WRITERS#' + json.dumps([filing, old], separators=(',', ':')):
        return _settled_writer(item, filing, new)
    elif pk == 'AGENT_COMPUTER#' + session['pk'].removeprefix('SESSIONS#') and sk == f'SCREENSHOT#{old}':
        result['sk'] = f'SCREENSHOT#{new}'
    else:
        raise RuntimeError('Unsupported reference; preserve it and review the migration scope')
    return result


def _settled_writer(item: Item, filing: str, new: str) -> Item:
    if item.get('runtime_writers', 0) != 0 or 'external_token' in item:
        raise RuntimeError('Writer control is not settled')
    return {**item, 'pk': 'WRITERS#' + json.dumps([filing, new], separators=(',', ':'))}


def memory_events(client: Any, memory: str, actor: str, session: str) -> int:
    total = 0
    params: Item = {'memoryId': memory, 'actorId': actor, 'sessionId': session,
                    'includePayloads': False, 'maxResults': 100}
    while True:
        page = client.list_events(**params)
        total += len(page['events'])
        if not page.get('nextToken'):
            return total
        params['nextToken'] = page['nextToken']


def empty_memory(client: Any, memory: str, actor: str, session: str) -> Item:
    prefix = 'lgw-' + hashlib.sha256(session.encode()).hexdigest()[:32] + '-'
    params: Item = {'memoryId': memory, 'actorId': actor, 'maxResults': 100}
    sessions = {session}
    while True:
        try:
            page = client.list_sessions(**params)
        except ClientError as error:
            detail = error.response.get('Error', {})
            if detail.get('Code') != 'ResourceNotFoundException' or detail.get('Message') != f'Actor {actor} not found':
                raise
            return {'actor': actor, 'session': session, 'event_counts': {session: 0}, 'actor_absent': True}
        sessions.update(row['sessionId'] for row in page['sessionSummaries'] if row['sessionId'].startswith(prefix))
        if not page.get('nextToken'):
            break
        params['nextToken'] = page['nextToken']
    counts = {name: memory_events(client, memory, actor, name) for name in sorted(sessions)}
    if any(counts.values()):
        raise RuntimeError('Memory or pending-write events exist; this tool never migrates or deletes history')
    return {'actor': actor, 'session': session, 'event_counts': counts}


def candidate(items: list[Item], source: Item, new: str, client: Any, memory: str) -> Item:
    owner = source['pk'].removeprefix('SESSIONS#')
    if 'deleted_at' in source or 'turn_running_since' in source:
        raise RuntimeError('Session is fenced or has an unsettled Turn')
    changes = [{'before': encoded(row), 'after': encoded(replacement(row, source, new))}
               for row in references(items, source)]
    checks = [empty_memory(client, memory, actor, session)
              for actor in sorted(history_owners(items, source) | {source['filing_user_id']})
              for session in (source['session_id'], new)]
    return {'owner': owner, 'filing_user_id': source['filing_user_id'], 'old': source['session_id'],
            'new': new, 'changes': changes, 'memory_checks': checks}


def plan(items: list[Item], client: Any, *, table: str, memory: str, region: str, decision_repository: str,
         decision_item: int) -> Item:
    groups = collisions(items)
    proposed = [_plan_group(items, group, client, memory) for group in groups]
    return {'migration': MIGRATION, 'schema': 1, 'table': table, 'memory': memory, 'region': region,
            'decision_repository': decision_repository, 'decision_item': decision_item,
            'inventory_sha256': digest([encoded(item) for item in items]),
            'collision_records': [encoded(item) for group in groups for item in group],
            'reids': [choice for choice, _ in proposed if choice is not None],
            'blockers': [blocker for _, blocker in proposed if blocker is not None]}


def _plan_group(items: list[Item], group: list[Item], client: Any, memory: str) -> tuple[Item | None, Item | None]:
    choices, refusals = [], []
    for source in sorted(group, key=lambda item: (item['filing_user_id'], item['pk'])):
        new = str(uuid4())
        if any(new in value for item in items for value in strings(item)):
            raise RuntimeError('New UUID already appears in the inventory')
        try:
            choices.append(candidate(items, source, new, client, memory))
        except RuntimeError as error:
            refusals.append(str(error))
    if choices:
        return min(choices, key=lambda choice: len(choice['changes'])), None
    return None, {'group': digest([encoded(item) for item in group]), 'reasons': refusals}


def changes(manifest: Item) -> list[Item]:
    if manifest.get('migration') != MIGRATION or manifest['schema'] != 1 or manifest['blockers'] or len(manifest['reids']) != 3:
        raise RuntimeError('Manifest is blocked or outside the approved scope')
    return [change for reid in manifest['reids'] for change in reid['changes']]


def verify_memory(manifest: Item, client: Any) -> None:
    for reid in manifest['reids']:
        for check in reid['memory_checks']:
            if empty_memory(client, manifest['memory'], check['actor'], check['session']) != check:
                raise RuntimeError('Memory census changed; regenerate and review the manifest')


def backup(manifest: Item, table: Any, client: Any) -> Item:
    changes(manifest)
    if digest([encoded(item) for item in scan(table)]) != manifest['inventory_sha256']:
        raise RuntimeError('Inventory changed; regenerate and review the manifest')
    verify_memory(manifest, client)
    return {'migration': MIGRATION, 'manifest_sha256': digest(manifest),
            'collision_records': manifest['collision_records'], 'changes': changes(manifest)}


def equality(item: Item) -> Item:
    fields = sorted(set(item) - {'pk', 'sk'})
    return {'ConditionExpression': 'attribute_exists(pk)' + ''.join(f' AND #a{n} = :v{n}' for n in range(len(fields))),
            'ExpressionAttributeNames': {f'#a{n}': name for n, name in enumerate(fields)},
            'ExpressionAttributeValues': {f':v{n}': item[name] for n, name in enumerate(fields)}}


def transaction(manifest: Item, *, rollback: bool = False) -> list[Item]:
    operations = []
    for change in changes(manifest):
        before, after = (decoded(change[name]) for name in (('after', 'before') if rollback else ('before', 'after')))
        operations.extend(_row_operations(manifest['table'], before, after))
    keys = [op['Put']['Item'] if 'Put' in op else op['Delete']['Key'] for op in operations]
    identities = [(key['pk'], key['sk']) for key in keys]
    if len(set(identities)) != len(identities):
        raise RuntimeError('Manifest writes the same key more than once')
    if len(operations) > 100 or len(json.dumps([encoded(op) for op in operations])) > 3_500_000:
        raise RuntimeError('Migration exceeds one DynamoDB transaction; review scope')
    return operations


def _row_operations(table: str, before: Item, after: Item) -> list[Item]:
    old_key, new_key = ({name: row[name] for name in ('pk', 'sk')} for row in (before, after))
    if old_key == new_key:
        return [{'Put': {'TableName': table, 'Item': after, **equality(before)}}]
    return [
        {'Put': {'TableName': table, 'Item': after, 'ConditionExpression': 'attribute_not_exists(pk)'}},
        {'Delete': {'TableName': table, 'Key': old_key, **equality(before)}},
    ]


def execute(manifest: Item, saved: Item, approval: Item, table: Any, client: Any, *, rollback: bool = False) -> None:
    operation = 'rollback' if rollback else 'apply'
    expected = {'migration': MIGRATION, 'operation': operation, 'manifest_sha256': digest(manifest), 'backup_sha256': digest(saved)}
    if any(approval.get(key) != value for key, value in expected.items()):
        raise RuntimeError('Operator approval does not name this exact manifest, backup and operation')
    decision = rf"https://github.com/{re.escape(manifest['decision_repository'])}/issues/{manifest['decision_item']}#issuecomment-\d+"
    if not re.fullmatch(decision, approval.get('decision_url', '')):
        raise RuntimeError("Operator approval must cite the migration decision in the manifest's tracker item")
    if any(approval.get(name) is not True for name in ATTESTATIONS):
        raise RuntimeError('Operator must attest ADR approval, freeze, retirement, stop and backup restoration')
    if saved != {'migration': MIGRATION, 'manifest_sha256': digest(manifest),
                 'collision_records': manifest['collision_records'], 'changes': changes(manifest)}:
        raise RuntimeError('Backup does not preserve the exact manifest before images')
    operations = transaction(manifest, rollback=rollback)
    verify_memory(manifest, client)
    current = {(item['pk'], item['sk']): encoded(item) for item in scan(table)}
    desired = 'before' if rollback else 'after'
    if all(current.get((decoded(row[desired])['pk'], decoded(row[desired])['sk'])) == row[desired]
           for row in changes(manifest)):
        _verify_removed_keys(manifest, current, rollback=rollback)
        _verify_references(manifest, current, image=desired)
        return
    if not rollback and digest(list(current.values())) != manifest['inventory_sha256']:
        raise RuntimeError('Inventory changed; regenerate and review the manifest')
    _verify_source_images(manifest, current, rollback=rollback)
    _verify_references(manifest, current, image='after' if rollback else 'before')
    table.meta.client.transact_write_items(TransactItems=operations, ClientRequestToken=digest(expected)[:36])
    actual = {(item['pk'], item['sk']): encoded(item) for item in scan(table)}
    if not all(actual.get((decoded(row[desired])['pk'], decoded(row[desired])['sk'])) == row[desired]
               for row in changes(manifest)):
        raise RuntimeError('Transaction outcome requires reconciliation against the backup')
    _verify_removed_keys(manifest, actual, rollback=rollback)
    _verify_references(manifest, actual, image=desired)


def _verify_references(manifest: Item, actual: dict[tuple[str, str], Item], *, image: str) -> None:
    items = [decoded(item) for item in actual.values()]
    for reid in manifest['reids']:
        identity = reid['old'] if image == 'before' else reid['new']
        session = {'pk': f"SESSIONS#{reid['owner']}", 'session_id': identity, 'filing_user_id': reid['filing_user_id']}
        found = [encoded(item) for item in references(items, session)]
        expected = [row[image] for row in reid['changes']]
        if sorted(map(digest, found)) != sorted(map(digest, expected)):
            raise RuntimeError('Reference inventory changed; keep admission closed and reconcile before writing')


def _verify_source_images(manifest: Item, actual: dict[tuple[str, str], Item], *, rollback: bool) -> None:
    for row in changes(manifest):
        source, target = (row[name] for name in (('after', 'before') if rollback else ('before', 'after')))
        old_key, new_key = ((decoded(item)['pk'], decoded(item)['sk']) for item in (source, target))
        if actual.get(old_key) != source or (old_key != new_key and new_key in actual):
            raise RuntimeError('Source changed or destination exists; reconcile before writing')


def _verify_removed_keys(manifest: Item, actual: dict[tuple[str, str], Item], *, rollback: bool) -> None:
    for row in changes(manifest):
        removed, kept = (decoded(row[name]) for name in (('after', 'before') if rollback else ('before', 'after')))
        old_key, new_key = ((item['pk'], item['sk']) for item in (removed, kept))
        if old_key != new_key and old_key in actual:
            raise RuntimeError('Both source and destination exist; reconcile before resuming admission')
