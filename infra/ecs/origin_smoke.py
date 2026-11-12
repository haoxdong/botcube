from __future__ import annotations

import json
import shlex
import signal
from collections.abc import Callable
from typing import TYPE_CHECKING, Any
from uuid import uuid4

import boto3
from botocore.exceptions import ClientError

if TYPE_CHECKING:
    from types_boto3_dynamodb.service_resource import Table


class OriginSmoke:
    def __init__(self, table: Table, stop: Callable[[str], None]):
        self.table, self.stop = table, stop
        self.stopped = False
        self.interrupted = False
        self.holder = str(uuid4())
        self.session: str | None = None
        self.key = {'pk': 'PAID_EXECUTION#origin-smoke', 'sk': 'META'}

    @classmethod
    def for_deployment(cls, table: Table, revision: str, timing: dict[str, Any]) -> OriginSmoke:
        definition = boto3.client('ecs').describe_task_definition(taskDefinition=revision)['taskDefinition']
        targets = [entry['value'] for container in definition['containerDefinitions'] if container['name'] == 'chat-service'
                   for entry in container.get('environment', []) if entry['name'] == 'AGENTCORE_RUNTIME_ARN']
        if len(targets) != 1:
            raise RuntimeError('Origin smoke requires one deployed Runtime target')
        runtime = boto3.client('bedrock-agentcore')

        def stop(session: str) -> None:
            runtime.stop_runtime_session(agentRuntimeArn=targets[0], runtimeSessionId=session, qualifier='DEFAULT')
            timing['runtimeStopConfirmed'] = True

        return cls(table, stop)

    def __enter__(self):
        try:
            self.table.put_item(Item={**self.key, 'holder': self.holder}, ConditionExpression='attribute_not_exists(pk)')
        except ClientError as error:
            if error.response['Error']['Code'] == 'ConditionalCheckFailedException':
                raise RuntimeError('Origin smoke slot occupied. ' + self.recovery('RECORDED_HOLDER')) from None
            raise
        self.previous_signal = signal.signal(signal.SIGTERM, self.terminated)
        return self

    def recovery(self, holder: str) -> str:
        key = json.dumps({name: {'S': value} for name, value in self.key.items()})
        read = shlex.join(['aws', 'dynamodb', 'get-item', '--table-name', self.table.name, '--key', key, '--consistent-read'])
        delete = shlex.join(['aws', 'dynamodb', 'delete-item', '--table-name', self.table.name, '--key', key,
                             '--condition-expression', 'holder = :holder',
                             '--expression-attribute-values', json.dumps({':holder': {'S': holder}})])
        return f'Read the recorded holder and session with {read}; confirm Runtime teardown, then recover with {delete} (use the recorded holder).'

    def terminated(self, _signal, _frame):
        self.interrupted = True
        raise RuntimeError('Origin smoke terminated; admission retained. ' + self.recovery(self.holder))

    def bind(self, owner: str, session: str) -> None:
        if self.session is not None:
            raise RuntimeError('Origin smoke permits one owned Runtime')
        self.table.update_item(Key=self.key, UpdateExpression='SET session_id = :session',
                               ConditionExpression='holder = :holder',
                               ExpressionAttributeValues={':holder': self.holder, ':session': session})
        self.session = session
        self.table.update_item(Key={'pk': 'SESSIONS#' + owner, 'sk': 'SESSION#' + session},
            UpdateExpression='SET browser_limit = :zero, single_turn = :single',
            ConditionExpression='session_id = :session AND attribute_not_exists(turn_latest_run_id) AND attribute_not_exists(title) AND attribute_not_exists(latest_message_id)',
            ExpressionAttributeValues={':zero': 0, ':single': True, ':session': session})

    def stop_runtime(self) -> None:
        if self.session is not None and not self.stopped:
            self.stop(self.session)
            self.stopped = True

    def __exit__(self, _error_type, _error, _traceback):
        try:
            try:
                self.stop_runtime()
            except Exception as error:
                raise RuntimeError('Origin smoke stop unconfirmed; admission retained. ' + self.recovery(self.holder)) from error
            if not self.interrupted and (self.stopped or self.session is None):
                self.table.delete_item(Key=self.key, ConditionExpression='holder = :holder',
                                       ExpressionAttributeValues={':holder': self.holder})
        finally:
            signal.signal(signal.SIGTERM, self.previous_signal)


def cleanup_conversation(client, thread_id: str, timing: dict[str, Any], request: Callable[..., tuple[int, Any]]) -> None:
    status, _ = request(client, '/threads/' + thread_id, method='DELETE')
    if status != 204:
        raise RuntimeError('Test conversation cleanup failed')
    status, history = request(client, '/threads')
    if status != 200 or any(thread['id'] == thread_id for thread in history['threads']):
        raise RuntimeError('Deleted test conversation remains in history')
    status, _ = request(client, '/threads/' + thread_id)
    if status != 404:
        raise RuntimeError('Deleted test conversation still replays')
    timing['conversationDeleted'] = True
