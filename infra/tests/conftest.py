from collections.abc import Iterator

import boto3
import pytest
from moto import mock_aws
from types_boto3_dynamodb.service_resource import Table


@pytest.fixture
def chat_table(monkeypatch: pytest.MonkeyPatch) -> Iterator[Table]:
    monkeypatch.delenv('AWS_ENDPOINT_URL_DYNAMODB', raising=False)
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'us-east-1')
    with mock_aws():
        table = boto3.resource('dynamodb').create_table(
            TableName='chat',
            KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
            AttributeDefinitions=[{'AttributeName': name, 'AttributeType': 'S'} for name in ('pk', 'sk')],
            BillingMode='PAY_PER_REQUEST',
        )
        yield table
