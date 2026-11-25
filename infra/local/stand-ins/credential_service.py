"""Local Credential Service run beside fake_site_provider.py."""

from __future__ import annotations

import os
from collections.abc import Callable
from functools import partial

import uvicorn
from fake_site_provider import FakeSiteProvider
from fastapi import FastAPI

from botcube_credential_service.audit import (
    CredentialAuditRecorder,
    StdoutCredentialAuditSink,
)
from botcube_credential_service.aws import env_vault
from botcube_credential_service.compose import credential_service_app
from botcube_credential_service.openai import OpenAIProvider
from botcube_credential_service.resolved_config import resolved_config_from_env
from botcube_credential_service.vault import DynamoDbCredentialVault


def local_credential_service(
    vault: Callable[[], DynamoDbCredentialVault], site_url: str, invocation_secret: Callable[[], str],
) -> FastAPI:
    audit = CredentialAuditRecorder(sink=StdoutCredentialAuditSink())
    return credential_service_app(
        'local', invocation_secret, partial(OpenAIProvider, vault), FakeSiteProvider(vault, site_url, audit),
        audit=audit, resolved=resolved_config_from_env(),
    )


def main() -> None:
    vault = env_vault('BOTCUBE_VAULT_TABLE', 'BOTCUBE_VAULT_KMS_KEY_ID', local_key_env='BOTCUBE_LOCAL_VAULT_KEY_FILE')
    uvicorn.run(
        local_credential_service(lambda: vault, os.environ['FAKE_SITE_URL'], lambda: os.environ['BOTCUBE_CREDENTIAL_INVOCATION_SECRET']),
        host='0.0.0.0', port=int(os.getenv('PORT', '8081')),
    )


if __name__ == '__main__':
    main()
