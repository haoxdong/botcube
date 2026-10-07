from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import TypedDict, Unpack

from deepagents.backends import LocalShellBackend
from deepagents.backends.protocol import ExecuteResponse


class LocalShellOptions(TypedDict, total=False):
    """The keyword options ``LocalShellBackend.__init__`` accepts."""

    root_dir: str | Path | None
    virtual_mode: bool
    timeout: int
    max_output_bytes: int
    env: dict[str, str] | None
    inherit_env: bool


class PolicyShellBackend(LocalShellBackend):
    """Shell backend whose command policy is supplied by a Cartridge."""

    def __init__(self, *, command_validator: Callable[[str], str | None], **kwargs: Unpack[LocalShellOptions]) -> None:
        super().__init__(**kwargs)
        self._command_validator = command_validator

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        error = self._command_validator(command)
        if error is not None:
            return ExecuteResponse(output=f'Error: {error}', exit_code=126)
        return super().execute(command, timeout=timeout)

    def set_environment_variable(self, key: str, value: str | None) -> None:
        """Update one process environment value without exposing backend internals."""
        if value is None:
            self._env.pop(key, None)
        else:
            self._env[key] = value
