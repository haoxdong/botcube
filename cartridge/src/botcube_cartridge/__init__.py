import shutil
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from hashlib import sha256
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
    """Framework-neutral Cartridge inputs consumed by any BotCube Harness."""

    skills: Sequence[str]
    agent_name: str
    prepare_invocation: Callable[[Any], InvocationAuth]
    prepare_root: Callable[[Path], object]
    session_id_env_var: str
    environment_cache_key: EnvironmentCacheKey
    build_shell_env: Callable[[Mapping[str, str]], dict[str, str]] = dict
    system_prompt: str = ''


def install_skill(root: Path, skills: str, name: str, source: Path) -> None:
    """Copy a skill's `SKILL.md` into the root, under the skills directory a `HarnessDefinition` names.

    A root that already holds `source` there, such as the checkout it came from, is left alone.
    """
    target = root / skills.strip('/') / name / 'SKILL.md'
    if source.resolve() == target.resolve():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


_FILING_USER_ID_MAX_LENGTH = 255


def filing_user_id(prefix: str, account_id: str) -> str:
    """The user ID an Account's Sessions and Memory are filed under.

    `<prefix>_` + the ID's UTF-8 hex, or `<prefix>_sha256_` + its SHA-256 when that is too long.
    The Chat Service's `filingUserId` derives the same ID, so the two must agree byte for byte.
    """
    encoded = account_id.encode('utf-8')
    filed = f'{prefix}_{encoded.hex()}'
    if len(filed) <= _FILING_USER_ID_MAX_LENGTH:
        return filed
    return f'{prefix}_sha256_{sha256(encoded).hexdigest()}'
