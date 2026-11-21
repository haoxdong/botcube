from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class OpenAISettings:
    issuer: str = 'https://auth.openai.com'
    resource: str = 'https://api.openai.com/v1'
    api_origin: str = 'https://api.openai.com'
    dynamic_client_id: str = 'dynamic_agent_client'

    @property
    def token_url(self) -> str:
        return f'{self.issuer}/api/accounts/oauth/token'
