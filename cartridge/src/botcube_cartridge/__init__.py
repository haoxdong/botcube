from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ModelRelay:
    """The Credential Service relay for a Turn's model calls."""

    base_url: str
    token: str
    headers: Mapping[str, str]
    session_id: str


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


