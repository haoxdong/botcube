from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Protocol

from botcube_config.generated.resolved_config_types import ResolvedConfig
from fastapi import FastAPI

from .audit import CredentialAuditRecorder
from .models import models_provider_from_config
from .openai import OPENAI_PROVIDER, OpenAIProvider
from .provider import CredentialProvider
from .proxy_relay import relay_provider_proxy
from .server import CredentialServiceSettings, create_app, plan_usage_owner


class PlanProviderFactory(Protocol):
    def __call__(self, *, audit: CredentialAuditRecorder, proxy: Callable[[], str] | None) -> OpenAIProvider: ...


def credential_service_app(
    name: str,
    invocation_secret: Callable[[], str],
    plan_provider: PlanProviderFactory,
    *site_providers: CredentialProvider[Any],
    audit: CredentialAuditRecorder,
    resolved: ResolvedConfig,
    erase_product_account: Callable[[str], Awaitable[None]] | None = None,
) -> FastAPI:
    config = resolved['config']
    settings = CredentialServiceSettings(name, invocation_secret, plan_usage_owner(config), erase_product_account)
    models = models_provider_from_config(audit, resolved)
    plan = plan_provider(audit=audit, proxy=relay_provider_proxy(config, OPENAI_PROVIDER))
    return create_app(settings, [*site_providers, plan, *([models] if models is not None else [])], config=config)
