"""The stock Credential Service: OpenAI and any models Endpoint, with no site provider, for a deploy that ships none."""

from __future__ import annotations

import os
from collections.abc import Callable

import uvicorn
from fastapi import FastAPI

from .audit import CredentialAuditRecorder, StdoutCredentialAuditSink
from .aws import env_vault
from .models import models_provider_from_config
from .openai import OpenAIProvider
from .resolved_config import resolved_config_from_env
from .server import CredentialServiceSettings, create_app, plan_usage_owner
from .vault import RotatingCredentialVault


def stock_credential_service(openai_vault: Callable[[], RotatingCredentialVault], invocation_secret: Callable[[], str]) -> FastAPI:
    audit = CredentialAuditRecorder(sink=StdoutCredentialAuditSink())
    config = resolved_config_from_env()
    models = models_provider_from_config(audit, config)
    settings = CredentialServiceSettings('stock', invocation_secret, plan_usage_owner_account_id=plan_usage_owner(config['config']))
    return create_app(settings, [OpenAIProvider(openai_vault, audit=audit), *([models] if models else [])], config=config['config'])


def main() -> None:
    vault = env_vault('BOTCUBE_VAULT_TABLE', 'BOTCUBE_VAULT_KMS_KEY_ID', local_key_env='BOTCUBE_LOCAL_VAULT_KEY_FILE')
    uvicorn.run(
        stock_credential_service(lambda: vault, lambda: os.environ['BOTCUBE_CREDENTIAL_INVOCATION_SECRET']),
        host='0.0.0.0', port=int(os.getenv('PORT', '8081')),
    )


if __name__ == '__main__':
    main()
