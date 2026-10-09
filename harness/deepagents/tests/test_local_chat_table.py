"""Development-only fresh table admission prerequisite."""

import runpy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import boto3
import pytest

INITIALIZER = Path(__file__).resolve().parents[3] / 'infra/local/init-chat-table.py'


class MissingTable(Exception):
    pass


@pytest.fixture
def local_table(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    monkeypatch.setenv('AWS_ENDPOINT_URL_DYNAMODB', 'http://dynamodb:8000')
    monkeypatch.setenv('BOTCUBE_CHAT_TABLE', 'development-chat')
    client = MagicMock()
    client.exceptions = SimpleNamespace(ResourceNotFoundException=MissingTable)
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: client)
    return client


def test_fresh_local_table_admits_tracked_sessions(local_table: MagicMock) -> None:
    local_table.describe_table.side_effect = MissingTable
    runpy.run_path(str(INITIALIZER))
    local_table.create_table.assert_called_once()
    local_table.put_item.assert_called_once_with(
        TableName='development-chat',
        ConditionExpression='attribute_not_exists(pk)',
        Item={
            'pk': {'S': 'RUNTIME_DISPATCHERS'},
            'sk': {'S': 'CLOSED'},
            'old_chat_retired': {'BOOL': True},
            'memory_broker_only': {'BOOL': True},
        },
    )


def test_existing_local_table_remains_unproved(local_table: MagicMock) -> None:
    runpy.run_path(str(INITIALIZER))
    local_table.create_table.assert_not_called()
    local_table.put_item.assert_not_called()


def test_other_endpoint_cannot_assert_retirement(local_table: MagicMock, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('AWS_ENDPOINT_URL_DYNAMODB', 'https://dynamodb.us-east-1.amazonaws.com')
    with pytest.raises(ValueError, match='only for the Compose'):
        runpy.run_path(str(INITIALIZER))
    local_table.put_item.assert_not_called()
