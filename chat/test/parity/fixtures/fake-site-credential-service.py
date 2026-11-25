"""The fake site's Credential Service, its vault in moto. Run by path with the Credential Service's own venv."""
from __future__ import annotations

import os
from functools import partial

import boto3
import uvicorn
from botcube_config.resolved_config import resolved_config_from_env
from fake_site_provider import FakeSiteProvider
from moto import mock_aws

from botcube_credential_service.audit import (
    CredentialAuditRecorder,
    StdoutCredentialAuditSink,
)
from botcube_credential_service.compose import credential_service_app
from botcube_credential_service.data_keys import (
    Boto3KmsDataKeyProvider,
)
from botcube_credential_service.openai import OpenAIProvider
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
    audit = CredentialAuditRecorder(sink=StdoutCredentialAuditSink())
    app = credential_service_app(
        'fake-site', lambda: os.environ['BOTCUBE_CREDENTIAL_INVOCATION_SECRET'],
        partial(OpenAIProvider, lambda: vault), FakeSiteProvider(lambda: vault, os.environ['FAKE_SITE_URL'], audit),
        audit=audit, resolved=resolved_config_from_env(),
    )
    uvicorn.run(app, host='127.0.0.1', port=int(os.environ['PORT']))
