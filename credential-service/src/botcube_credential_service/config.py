from __future__ import annotations

import math
import os
from dataclasses import dataclass
from urllib.parse import urlsplit


def positive_seconds(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, str(default)))
    except ValueError as error:
        raise ValueError(f'{name} must be finite and positive') from error
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f'{name} must be finite and positive')
    return value


def _https_url(name: str, default: str, *, origin: bool = False) -> str:
    value = os.environ.get(name, default)
    try:
        url = urlsplit(value)
        _ = url.port
    except ValueError as error:
        raise ValueError(f'{name} must be a valid HTTPS URL') from error
    if (url.scheme != 'https' or not url.hostname or url.username is not None
            or url.password is not None or url.query or url.fragment
            or (origin and url.path not in ('', '/'))):
        raise ValueError(f'{name} must be an HTTPS {"origin" if origin else "URL"} without credentials, query or fragment')
    return value.rstrip('/')


@dataclass(frozen=True)
class OpenAISettings:
    issuer: str
    resource: str
    api_origin: str
    dynamic_client_id: str

    @property
    def token_url(self) -> str:
        return f'{self.issuer}/api/accounts/oauth/token'

    @classmethod
    def from_env(cls) -> OpenAISettings:
        client_id = os.environ.get('BOTCUBE_OPENAI_DYNAMIC_CLIENT_ID', 'dynamic_agent_client')
        if not client_id.strip():
            raise ValueError('BOTCUBE_OPENAI_DYNAMIC_CLIENT_ID must not be empty')
        return cls(
            issuer=_https_url('BOTCUBE_OPENAI_ISSUER', 'https://auth.openai.com', origin=True),
            resource=_https_url('BOTCUBE_OPENAI_RESOURCE', 'https://api.openai.com/v1'),
            api_origin=_https_url('BOTCUBE_OPENAI_API_ORIGIN', 'https://api.openai.com', origin=True),
            dynamic_client_id=client_id,
        )
