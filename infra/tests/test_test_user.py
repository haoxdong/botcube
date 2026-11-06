from unittest.mock import Mock, patch

import boto3
import pytest
from moto import mock_aws
from test_user import test_user as operator_user


@mock_aws
def test_operator_user_is_isolated_and_cleaned_after_a_failed_check() -> None:
    table = boto3.resource('dynamodb', region_name='us-east-1').create_table(
        TableName='chat', KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'},
                                    {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
        AttributeDefinitions=[{'AttributeName': key, 'AttributeType': 'S'} for key in ['pk', 'sk']],
        BillingMode='PAY_PER_REQUEST')
    response = Mock(status=204)
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=False)
    opener = Mock(addheaders=[])
    opener.open.return_value = response
    with patch('urllib.request.build_opener', return_value=opener), pytest.raises(RuntimeError, match='failed check'), operator_user(table, 'https://chat.example') as (client, user_id):
        assert user_id.startswith('acct_')
        assert client.addheaders[0][0] == 'x-botcube-test-user'
        assert client.addheaders[0][1].startswith('test_')
        item = table.get_item(Key={'pk': 'ACCOUNT#' + user_id, 'sk': 'META'}).get('Item')
        assert item is not None
        record = item['record']
        assert isinstance(record, dict)
        assert record['status'] == 'test'
        assert 'gsIdentity' not in record
        table.put_item(Item={'pk': 'SESSIONS#' + user_id, 'sk': 'MAIN', 'session_id': 'allocated-main'})
        table.put_item(Item={'pk': 'SESSIONS#' + user_id, 'sk': 'DELETED', 'deleted_at': 'now'})
        raise RuntimeError('failed check')
    assert table.scan()['Items'] == []

    cleanup = opener.open.call_args.args[0]
    assert cleanup.full_url == 'https://chat.example/operator/test-user'
    assert cleanup.method == 'DELETE'


@mock_aws
def test_access_is_refreshed_before_the_check_and_the_user_is_deleted_afterward() -> None:
    table = boto3.resource('dynamodb', region_name='us-east-1').create_table(
        TableName='chat', KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
        AttributeDefinitions=[{'AttributeName': key, 'AttributeType': 'S'} for key in ['pk', 'sk']],
        BillingMode='PAY_PER_REQUEST')
    refreshed, deleted = Mock(status=201), Mock(status=204)
    for response in [refreshed, deleted]:
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
    opener = Mock(addheaders=[])
    opener.open.side_effect = [refreshed, deleted]
    with patch('urllib.request.build_opener', return_value=opener), operator_user(
        table, 'https://chat.example', operator_token='operator-copy-token',
    ):
        assert opener.open.call_count == 1
        refresh = opener.open.call_args.args[0]
        assert refresh.full_url == 'https://chat.example/operator/test-user/connector'
        assert refresh.get_header('Authorization') == 'Bearer operator-copy-token'
    assert table.scan().get('Items') == []
    assert opener.open.call_args.args[0].method == 'DELETE'
