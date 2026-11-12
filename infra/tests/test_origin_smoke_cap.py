from unittest.mock import Mock

import boto3
import pytest
from moto import mock_aws
from origin_smoke import OriginSmoke


@mock_aws
def test_smoke_admission_is_shared_and_released_only_after_stop():
    table = boto3.resource('dynamodb', region_name='us-east-1').create_table(
        TableName='chat', KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
        AttributeDefinitions=[{'AttributeName': key, 'AttributeType': 'S'} for key in ('pk', 'sk')], BillingMode='PAY_PER_REQUEST')
    table.put_item(Item={'pk': 'SESSIONS#owner', 'sk': 'SESSION#session', 'session_id': 'session'})
    stop = Mock()
    with OriginSmoke(table, stop) as first:
        first.bind('owner', 'session')
        with pytest.raises(RuntimeError, match='occupied'), OriginSmoke(table, stop):
            pytest.fail('competing deploy admitted')
        policy = table.get_item(Key={'pk': 'SESSIONS#owner', 'sk': 'SESSION#session'})['Item']
        assert policy['browser_limit'] == 0 and policy['single_turn'] is True
    stop.assert_called_once_with('session')
    with OriginSmoke(table, stop):
        pass


@mock_aws
def test_failed_stop_retains_slot_across_callers():
    table = boto3.resource('dynamodb', region_name='us-east-1').create_table(
        TableName='chat', KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
        AttributeDefinitions=[{'AttributeName': key, 'AttributeType': 'S'} for key in ('pk', 'sk')], BillingMode='PAY_PER_REQUEST')
    table.put_item(Item={'pk': 'SESSIONS#owner', 'sk': 'SESSION#session', 'session_id': 'session'})
    with pytest.raises(RuntimeError, match='stop unconfirmed'), OriginSmoke(table, Mock(side_effect=RuntimeError('stop unconfirmed'))) as smoke:
        smoke.bind('owner', 'session')
        raise ValueError('stream failed')
    with pytest.raises(RuntimeError, match='occupied'), OriginSmoke(table, Mock()):
        pytest.fail('unconfirmed stop freed admission')


@pytest.mark.parametrize('stop_before_failure', [False, True])
def test_assertion_failure_releases_slot_after_confirmed_stop(chat_table, stop_before_failure):
    chat_table.put_item(Item={'pk': 'SESSIONS#owner', 'sk': 'SESSION#session', 'session_id': 'session'})
    stop = Mock()
    with pytest.raises(AssertionError, match='replay mismatch'), OriginSmoke(chat_table, stop) as smoke:
        smoke.bind('owner', 'session')
        if stop_before_failure:
            smoke.stop_runtime()
        raise AssertionError('replay mismatch')
    stop.assert_called_once_with('session')
    with OriginSmoke(chat_table, Mock()):
        pass


def test_failure_before_session_binding_releases_slot(chat_table):
    with pytest.raises(AssertionError), OriginSmoke(chat_table, Mock()):
        raise AssertionError('setup failed')
    with OriginSmoke(chat_table, Mock()):
        pass


def test_sigterm_retains_slot_even_after_confirmed_stop(chat_table):
    chat_table.put_item(Item={'pk': 'SESSIONS#owner', 'sk': 'SESSION#session', 'session_id': 'session'})
    stop = Mock()
    with pytest.raises(RuntimeError, match='terminated'), OriginSmoke(chat_table, stop) as smoke:
        smoke.bind('owner', 'session')
        smoke.stop_runtime()
        smoke.terminated(None, None)
    stop.assert_called_once_with('session')
    with pytest.raises(RuntimeError, match='occupied'), OriginSmoke(chat_table, Mock()):
        pytest.fail('interrupted smoke freed admission')


def test_failed_stop_names_conditional_recovery_command(chat_table):
    chat_table.put_item(Item={'pk': 'SESSIONS#owner', 'sk': 'SESSION#session', 'session_id': 'session'})
    with pytest.raises(RuntimeError, match='aws dynamodb delete-item') as failure, OriginSmoke(chat_table, Mock(side_effect=RuntimeError('stop failed'))) as smoke:
        smoke.bind('owner', 'session')
    assert smoke.holder in str(failure.value)
    assert '--condition-expression' in str(failure.value)
    assert chat_table.get_item(Key=smoke.key)['Item']['holder'] == smoke.holder
