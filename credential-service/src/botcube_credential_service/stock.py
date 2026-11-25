"""The stock Credential Service: OpenAI and any models Endpoint, with no site provider, for a deploy that ships none."""

from __future__ import annotations

import os
from collections.abc import Callable
from functools import partial

import uvicorn
from fastapi import FastAPI

from .audit import CredentialAuditRecorder, StdoutCredentialAuditSink
from .aws import env_vault
from .compose import credential_service_app
from .openai import OpenAIProvider
from .resolved_config import resolved_config_from_env
from .vault import RotatingCredentialVault


def stock_credential_service(openai_vault: Callable[[], RotatingCredentialVault], invocation_secret: Callable[[], str]) -> FastAPI:
    audit = CredentialAuditRecorder(sink=StdoutCredentialAuditSink())
    return credential_service_app(
        'stock', invocation_secret, partial(OpenAIProvider, openai_vault), audit=audit, resolved=resolved_config_from_env(),
    )


def main() -> None:
    vault = env_vault('BOTCUBE_VAULT_TABLE', 'BOTCUBE_VAULT_KMS_KEY_ID', local_key_env='BOTCUBE_LOCAL_VAULT_KEY_FILE')
    uvicorn.run(
        stock_credential_service(lambda: vault, lambda: os.environ['BOTCUBE_CREDENTIAL_INVOCATION_SECRET']),
        host='0.0.0.0', port=int(os.getenv('PORT', '8081')),
    )


if __name__ == '__main__':
    main()
