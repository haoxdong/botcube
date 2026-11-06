from __future__ import annotations

import os
from collections.abc import Callable

import uvicorn
from fastapi import FastAPI

from botcube_always_on.site_provider import FakeSiteProvider
from botcube_credential_service.audit import (
    CredentialAuditRecorder,
    StdoutCredentialAuditSink,
)
from botcube_credential_service.aws import env_vault
from botcube_credential_service.compose import credential_service_app
from botcube_credential_service.server import CredentialServiceSettings
from botcube_credential_service.vault import DynamoDbCredentialVault


def template_credential_service(
    vault: Callable[[], DynamoDbCredentialVault], site_url: str, invocation_secret: Callable[[], str],
) -> FastAPI:
    audit = CredentialAuditRecorder(sink=StdoutCredentialAuditSink())
    return credential_service_app(
        CredentialServiceSettings(
            'template', invocation_secret,
            plan_usage_owner_account_id=os.environ.get('BOTCUBE_PLAN_USAGE_OWNER_ACCOUNT_ID', ''),
        ),
        FakeSiteProvider(vault, site_url, audit),
        vault,
        audit=audit,
    )


def main() -> None:
    vault = env_vault('BOTCUBE_VAULT_TABLE', 'BOTCUBE_VAULT_KMS_KEY_ID', local_key_env='BOTCUBE_LOCAL_VAULT_KEY_FILE')
    uvicorn.run(
        template_credential_service(lambda: vault, os.environ['TEMPLATE_SITE_URL'], lambda: os.environ['BOTCUBE_CREDENTIAL_INVOCATION_SECRET']),
        host='0.0.0.0', port=int(os.getenv('PORT', '8081')),
    )


if __name__ == '__main__':
    main()
