import base64
import contextlib
import gzip
import json
import os
from typing import Any

import boto3


def without_metric(message: str) -> str:
    """The audit copy of a line, minus its embedded metric: CloudWatch extracts `_aws` from the copy too."""
    if '"_aws"' not in message:
        return message
    record = json.loads(message)
    del record['_aws']
    return json.dumps(record)


def handler(event: dict[str, Any], context: object) -> None:
    delivery = json.loads(gzip.decompress(base64.b64decode(event['awslogs']['data'])))
    if delivery['messageType'] != 'DATA_MESSAGE':
        return
    logs = boto3.client('logs')
    group, stream = os.environ['AUDIT_LOG_GROUP'], delivery['logStream']
    with contextlib.suppress(logs.exceptions.ResourceAlreadyExistsException):
        logs.create_log_stream(logGroupName=group, logStreamName=stream)
    rejected = logs.put_log_events(
        logGroupName=group, logStreamName=stream,
        logEvents=[{'timestamp': line['timestamp'], 'message': without_metric(line['message'])} for line in delivery['logEvents']],
    ).get('rejectedLogEventsInfo')
    if rejected:
        raise RuntimeError(f'{group} rejected audit events from {stream}: {rejected}')
