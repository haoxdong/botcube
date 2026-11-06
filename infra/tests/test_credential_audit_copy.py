import base64
import gzip
import json
import time
from collections.abc import Iterator

import boto3
import pytest
from credential_audit_copy import handler
from moto import mock_aws
from types_boto3_logs import CloudWatchLogsClient

AUDIT = '/cube/credential-service'
STREAM = 'credential-service/credential-service/task-1'


@pytest.fixture
def logs(monkeypatch: pytest.MonkeyPatch) -> Iterator[CloudWatchLogsClient]:
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'us-east-1')
    monkeypatch.setenv('AUDIT_LOG_GROUP', AUDIT)
    with mock_aws():
        client = boto3.client('logs')
        client.create_log_group(logGroupName=AUDIT)
        yield client


def delivery(*messages: str, age_days: int = 0) -> dict[str, dict[str, str]]:
    now = int((time.time() - age_days * 86400) * 1000)
    payload = {
        'messageType': 'DATA_MESSAGE', 'logGroup': '/cube/credential-service-logs', 'logStream': STREAM,
        'logEvents': [{'id': str(index), 'timestamp': now + index, 'message': message} for index, message in enumerate(messages)],
    }
    return {'awslogs': {'data': base64.b64encode(gzip.compress(json.dumps(payload).encode())).decode()}}


def copied(logs: CloudWatchLogsClient) -> list[str | None]:
    return [event.get('message') for event in logs.get_log_events(logGroupName=AUDIT, logStreamName=STREAM)['events']]


def test_every_delivered_event_is_copied_verbatim_since_the_subscription_filter_selected_it(logs: CloudWatchLogsClient) -> None:
    events = ['{"accountId": "acct-1", "event": "kms_decrypt", "timestamp": 1}', 'INFO: 127.0.0.1 - "POST /rpc HTTP/1.1" 200']
    handler(delivery(*events), None)

    assert copied(logs) == events


def test_later_deliveries_from_the_same_stream_append(logs: CloudWatchLogsClient) -> None:
    first = '{"accountId": "acct-1", "event": "session_remint"}'
    second = '{"accountId": "acct-2", "event": "session_reuse"}'
    handler(delivery(first), None)
    handler(delivery(second), None)

    assert copied(logs) == [first, second]


def test_the_subscription_handshake_writes_nothing(logs: CloudWatchLogsClient) -> None:
    control = {'messageType': 'CONTROL_MESSAGE', 'logGroup': '', 'logStream': '', 'logEvents': [
        {'id': '', 'timestamp': int(time.time() * 1000), 'message': 'CWL CONTROL MESSAGE: Checking health of destination Lambda.'}]}
    handler({'awslogs': {'data': base64.b64encode(gzip.compress(json.dumps(control).encode())).decode()}}, None)

    assert logs.describe_log_streams(logGroupName=AUDIT)['logStreams'] == []


def test_events_the_audit_group_rejects_fail_the_invocation_so_it_retries_and_alarms(logs: CloudWatchLogsClient) -> None:
    with pytest.raises(RuntimeError, match='rejected'):
        handler(delivery('{"accountId": "acct-1", "event": "kms_decrypt"}', age_days=15), None)


def test_a_copied_event_keeps_its_fields_but_not_its_metric_so_the_metric_is_published_once(logs: CloudWatchLogsClient) -> None:
    timing = {'accountId': 'acct-1', 'event': 'provider_first_answer', 'Moment': 'provider-first-token', 'Latency': 3223.9,
              '_aws': {'Timestamp': 1, 'CloudWatchMetrics': [{'Namespace': 'RUM/CustomMetrics/WebLatency', 'Dimensions': [['Moment']],
                                                              'Metrics': [{'Name': 'Latency', 'Unit': 'Milliseconds'}]}]}}
    handler(delivery(json.dumps(timing)), None)

    [message] = copied(logs)
    assert json.loads(message or '') == {key: value for key, value in timing.items() if key != '_aws'}
