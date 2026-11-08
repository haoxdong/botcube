from __future__ import annotations

import os

import boto3
import uvicorn
from moto import mock_aws

from botcube_always_on.credential_service import template_credential_service
from botcube_credential_service.data_keys import (
    Boto3KmsDataKeyProvider,
)
from botcube_credential_service.vault import (
    DynamoDbCredentialVault,
)

with mock_aws():
    table = boto3.resource('dynamodb', region_name='us-east-1').create_table(
        TableName='local-vault',
        KeySchema=[{'AttributeName': 'accountId', 'KeyType': 'HASH'}, {'AttributeName': 'provider', 'KeyType': 'RANGE'}],
        AttributeDefinitions=[{'AttributeName': 'accountId', 'AttributeType': 'S'}, {'AttributeName': 'provider', 'AttributeType': 'S'}],
        BillingMode='PAY_PER_REQUEST',
    )
    kms = boto3.client('kms', region_name='us-east-1')
    key = kms.create_key()['KeyMetadata']['KeyId']
    vault = DynamoDbCredentialVault(table, Boto3KmsDataKeyProvider(key_id=key, client=kms))
    app = template_credential_service(lambda: vault, os.environ['TEMPLATE_SITE_URL'], lambda: os.environ['BOTCUBE_CREDENTIAL_INVOCATION_SECRET'])
    uvicorn.run(app, host='127.0.0.1', port=int(os.environ['PORT']))
