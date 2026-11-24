"""What the Harness serves a bot with: its invocation identity, model relay, shell and skills."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


@dataclass(frozen=True)
class ModelRelay:
    """The Credential Service relay for a Turn's model calls."""

    base_url: str
    token: str
    headers: Mapping[str, str]
    session_id: str

    @property
    def models_url(self) -> str:
        url = urlsplit(self.base_url)
        return f'{url.scheme}://{url.netloc}/models'


def openai_model_relay(
    credential_service_url: str, token: str, session_id: str, account_id: str | None = None,
) -> ModelRelay:
    """The Credential Service's OpenAI relay, under the Turn's invocation token and for the Session it was signed for.

    The OpenAI provider sits at the service root, whatever provider prefix the bound URL names.
    """
    url = urlsplit(credential_service_url)
    headers = {'X-BotCube-Session-Id': session_id}
    if account_id is not None:
        headers['X-BotCube-Account-Id'] = account_id
    return ModelRelay(base_url=f'{url.scheme}://{url.netloc}/openai/v1', token=token, headers=headers, session_id=session_id)


@dataclass(frozen=True)
class InvocationAuth:
    actor_id: str | None
    persistent_memory: bool
    environment: Mapping[str, str] | None
    model_relay: ModelRelay | None = None
    system_prompt: str = ''


SESSION_ID_HEADER = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'
CREDENTIAL_INVOCATION_HEADER = 'X-BotCube-Credential-Invocation'


@dataclass
class InvocationContext:
    session_id: str | None
    credential_token: str | None = field(default=None, repr=False)
    _auth: InvocationAuth | None = field(default=None, init=False, repr=False)

    @classmethod
    def from_request(cls, headers: Mapping[str, str], forwarded: Any) -> InvocationContext:
        # Origin deploys after the Harness. Strip the old Origin's token at ingress during that interval.
        legacy = forwarded.pop('credentialServiceInvocationToken', None) if isinstance(forwarded, dict) else None
        token = headers.get(CREDENTIAL_INVOCATION_HEADER)
        return cls(headers.get(SESSION_ID_HEADER), token or (legacy if isinstance(legacy, str) else None))

    def prepare(self, run: Any, prepare: Callable[[Any, str | None], InvocationAuth]) -> InvocationAuth:
        if self._auth is None:
            self._auth = prepare(run, self.credential_token)
        return self._auth


EnvironmentCacheKey = Callable[[Mapping[str, str] | None], tuple[tuple[str, str], ...]]


def environment_cache_key(*per_turn_keys: str) -> EnvironmentCacheKey:
    """Key a cached agent by its environment, less the values every Turn re-issues.

    A cached agent's shell takes a per-Turn value instead of a rebuild.
    """
    excluded = frozenset(per_turn_keys)

    def key(environment: Mapping[str, str] | None) -> tuple[tuple[str, str], ...]:
        return tuple(sorted((name, value) for name, value in (environment or {}).items() if name not in excluded))

    return key


@dataclass(frozen=True)
class HarnessDefinition:
    """The bot the Harness serves: its skills, agent name, invocation identity, root and shell environment keys."""

    skills: Sequence[str]
    agent_name: str
    prepare_invocation: Callable[[Any, str | None], InvocationAuth]
    prepare_root: Callable[[Path], object]
    session_id_env_var: str
    environment_cache_key: EnvironmentCacheKey
    system_prompt: str = ''
