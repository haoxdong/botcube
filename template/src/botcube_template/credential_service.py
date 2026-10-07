from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

import boto3
from fastapi import FastAPI

from botcube_credential_service.audit import (
    CredentialAuditRecorder,
    StdoutCredentialAuditSink,
)
from botcube_credential_service.openai import OpenAIProvider
from botcube_credential_service.server import CredentialServiceSettings, create_app
from botcube_credential_service.vault import (
    Boto3KmsDataKeyProvider,
    DynamoDbCredentialVault,
    RotatingCredentialVault,
)
from botcube_template.local_keys import LocalDataKeyProvider
from botcube_template.site_provider import FakeSiteProvider


def template_credential_service(
    vault: Callable[[], RotatingCredentialVault], site_url: str, invocation_secret: Callable[[], str],
) -> FastAPI:
    return create_app(
        CredentialServiceSettings(
            'template', invocation_secret, 'X-Template-Account', 'X-Template-Session',
            plan_usage_owner_account_id=os.environ.get('BOTCUBE_PLAN_USAGE_OWNER_ACCOUNT_ID', ''),
        ),
        [FakeSiteProvider(vault, site_url), OpenAIProvider(vault, audit=CredentialAuditRecorder(sink=StdoutCredentialAuditSink()))],
    )


def main() -> None:
    import uvicorn

    dynamodb: Any = boto3.resource('dynamodb', endpoint_url=os.environ.get('DYNAMODB_ENDPOINT_URL'))
    table = dynamodb.Table(os.environ['BOTCUBE_VAULT_TABLE'])
    local_key = os.environ.get('BOTCUBE_LOCAL_VAULT_KEY_FILE')
    keys = LocalDataKeyProvider(Path(local_key)) if local_key else Boto3KmsDataKeyProvider(key_id=os.environ['BOTCUBE_VAULT_KMS_KEY_ID'])
    vault = DynamoDbCredentialVault(table, keys)
    app = template_credential_service(lambda: vault, os.environ['TEMPLATE_SITE_URL'], lambda: os.environ['BOTCUBE_CREDENTIAL_INVOCATION_SECRET'])
    uvicorn.run(app, host='0.0.0.0', port=int(os.environ.get('PORT', '8125')))


if __name__ == '__main__':
    main()
