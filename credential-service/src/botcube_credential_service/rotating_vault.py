from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from .audit import CredentialAuditRecorder
    from .vault import RevisedCredential, RotatingCredentialVault

OPENAI_PROVIDER = 'openai'


class AsyncRotatingVault(Protocol):
    async def store(self, account_id: str, value: str) -> None: ...
    async def delete(self, account_id: str) -> None: ...
    async def revision(self, account_id: str) -> str: ...
    async def load(
        self, account_id: str, audit: CredentialAuditRecorder, request_context: Mapping[str, str],
    ) -> RevisedCredential: ...
    async def take(self, account_id: str, *, revision: str, lease: str, now: float, expires_at: float) -> None: ...
    async def renew(self, account_id: str, *, revision: str, lease: str, expires_at: float) -> None: ...
    async def replace(self, account_id: str, value: str, *, revision: str, lease: str) -> str: ...


class OpenAIVaultAdapter:
    def __init__(self, vault: RotatingCredentialVault) -> None:
        self._vault = vault

    async def store(self, account_id: str, value: str) -> None:
        await asyncio.to_thread(self._vault.store_durable_credential, account_id, OPENAI_PROVIDER, value)

    async def delete(self, account_id: str) -> None:
        await asyncio.to_thread(self._vault.delete_durable_credential, account_id, OPENAI_PROVIDER)

    async def revision(self, account_id: str) -> str:
        return await asyncio.to_thread(self._vault.load_credential_revision, account_id, OPENAI_PROVIDER)

    async def load(
        self, account_id: str, audit: CredentialAuditRecorder, request_context: Mapping[str, str],
    ) -> RevisedCredential:
        return await asyncio.to_thread(
            self._vault.load_revised_credential, account_id, OPENAI_PROVIDER,
            audit=audit, request_context=request_context,
        )

    async def take(self, account_id: str, *, revision: str, lease: str, now: float, expires_at: float) -> None:
        await asyncio.to_thread(
            self._vault.take_refresh_lease, account_id, OPENAI_PROVIDER,
            revision=revision, lease=lease, now=now, expires_at=expires_at,
        )

    async def renew(self, account_id: str, *, revision: str, lease: str, expires_at: float) -> None:
        await asyncio.to_thread(
            self._vault.renew_refresh_lease, account_id, OPENAI_PROVIDER,
            revision=revision, lease=lease, expires_at=expires_at,
        )

    async def replace(self, account_id: str, value: str, *, revision: str, lease: str) -> str:
        return await asyncio.to_thread(
            self._vault.replace_durable_credential, account_id, OPENAI_PROVIDER, value,
            revision=revision, lease=lease,
        )
