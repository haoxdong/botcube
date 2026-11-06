from collections.abc import Iterator
from typing import Any

import boto3
import pytest
from moto import mock_aws


@pytest.fixture
def table() -> Iterator[Any]:
    with mock_aws():
        dynamodb: Any = boto3.resource('dynamodb', region_name='us-east-1')
        yield dynamodb.create_table(
            TableName='vault',
            KeySchema=[
                {'AttributeName': 'accountId', 'KeyType': 'HASH'},
                {'AttributeName': 'provider', 'KeyType': 'RANGE'},
            ],
            AttributeDefinitions=[
                {'AttributeName': 'accountId', 'AttributeType': 'S'},
                {'AttributeName': 'provider', 'AttributeType': 'S'},
            ],
            BillingMode='PAY_PER_REQUEST',
        )
