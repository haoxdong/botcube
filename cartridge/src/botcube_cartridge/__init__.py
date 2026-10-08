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


@dataclass(frozen=True)
class HarnessDefinition:
    """Framework-neutral Cartridge inputs consumed by any BotCube Harness."""

    skills: Sequence[str]
    agent_name: str
    system_prompt: str
    no_persistent_memory_prompt: str
    execute_description: str
    prepare_invocation: Callable[[Any], InvocationAuth]
    command_validator: Callable[[str], str | None]
    prepare_root: Callable[[Path], object]
    build_shell_env: Callable[[Mapping[str, str]], dict[str, str]]
    shell_timeout: int
    max_output_bytes: int
    session_id_env_var: str
    environment_cache_key: Callable[[Mapping[str, str] | None], tuple[tuple[str, str], ...]]


