"""A Cartridge's Credential Service: its site provider beside the OpenAI plan provider, served by uvicorn."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import FastAPI

from .audit import CredentialAuditRecorder
from .openai import OpenAIProvider
from .provider import CredentialProvider
from .server import CredentialServiceSettings, create_app
from .vault import RotatingCredentialVault


def credential_service_app(
    settings: CredentialServiceSettings,
    site: CredentialProvider[Any],
    openai_vault: Callable[[], RotatingCredentialVault],
    *,
    audit: CredentialAuditRecorder,
) -> FastAPI:
    """The site provider and OpenAI under one audit recorder, so an account's decrypts count toward one rate limit
    whichever provider made them; the site provider must audit into the same `audit`."""
    return create_app(settings, [site, OpenAIProvider(openai_vault, audit=audit)])
