from __future__ import annotations

import math
import os
from dataclasses import dataclass


def positive_seconds(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, str(default)))
    except ValueError as error:
        raise ValueError(f'{name} must be finite and positive') from error
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f'{name} must be finite and positive')
    return value


@dataclass(frozen=True)
class OpenAISettings:
    issuer: str = 'https://auth.openai.com'
    resource: str = 'https://api.openai.com/v1'
    api_origin: str = 'https://api.openai.com'
    dynamic_client_id: str = 'dynamic_agent_client'

    @property
    def token_url(self) -> str:
        return f'{self.issuer}/api/accounts/oauth/token'
