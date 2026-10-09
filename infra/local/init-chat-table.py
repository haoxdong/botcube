"""Initialize the development-only DynamoDB Local table before Chat Service starts."""

import os
import time

import boto3
from botocore.config import Config
from botocore.exceptions import EndpointConnectionError

endpoint = os.environ['AWS_ENDPOINT_URL_DYNAMODB']
if endpoint != 'http://dynamodb:8000':
    raise ValueError('this initializer is only for the Compose DynamoDB Local service')
client = boto3.client(
    'dynamodb', config=Config(connect_timeout=1, read_timeout=2, retries={'max_attempts': 0})
)
# DynamoDB Local's JVM can still be starting when Compose starts this container.
for _ in range(60):
    try:
        client.list_tables()
        break
    except EndpointConnectionError:
        time.sleep(1)
else:
    raise TimeoutError(f'DynamoDB Local at {endpoint} did not accept connections within 60 seconds')
name = os.environ['BOTCUBE_CHAT_TABLE']
created = False
try:
    client.describe_table(TableName=name)
except client.exceptions.ResourceNotFoundException:
    client.create_table(
        TableName=name,
        KeySchema=[
            {'AttributeName': 'pk', 'KeyType': 'HASH'},
            {'AttributeName': 'sk', 'KeyType': 'RANGE'},
        ],
        AttributeDefinitions=[
            {'AttributeName': 'pk', 'AttributeType': 'S'},
            {'AttributeName': 'sk', 'AttributeType': 'S'},
        ],
        BillingMode='PAY_PER_REQUEST',
    )
    created = True
client.get_waiter('table_exists').wait(TableName=name)
if created:
    client.put_item(
        TableName=name,
        Item={
            'pk': {'S': 'RUNTIME_DISPATCHERS'},
            'sk': {'S': 'CLOSED'},
            'old_chat_retired': {'BOOL': True},
            'memory_broker_only': {'BOOL': True},
        },
        ConditionExpression='attribute_not_exists(pk)',
    )
