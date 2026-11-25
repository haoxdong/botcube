"""A bot's Credential Service: its site provider beside the OpenAI plan provider and any models Endpoint, served by uvicorn."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import FastAPI

from .audit import CredentialAuditRecorder
from .models import models_provider_from_config
from .openai import OPENAI_PROVIDER, OpenAIProvider
from .provider import CredentialProvider
from .proxy_relay import relay_provider_proxy
from .resolved_config import resolved_config_from_env
from .server import CredentialServiceSettings, create_app
from .vault import RotatingCredentialVault


def credential_service_app(
    settings: CredentialServiceSettings,
    site: CredentialProvider[Any],
    openai_vault: Callable[[], RotatingCredentialVault],
    *,
    audit: CredentialAuditRecorder,
) -> FastAPI:
    """The site provider, OpenAI and the deploy's models Endpoint under one audit recorder, so an account's decrypts
    count toward one rate limit whichever provider made them; the site provider must audit into the same `audit`."""
    resolved = resolved_config_from_env()
    config = resolved['config']
    models = models_provider_from_config(audit, resolved)
    openai = OpenAIProvider(openai_vault, audit=audit, proxy=relay_provider_proxy(config, OPENAI_PROVIDER))
    return create_app(settings, [site, openai, *([models] if models else [])], config=config)
