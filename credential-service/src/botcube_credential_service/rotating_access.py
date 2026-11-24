"""Refresh-token custody for Sign in with ChatGPT (ADR 0078)."""

from __future__ import annotations

import asyncio
import json
import secrets
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, TypedDict

from .openai_errors import revoked, unavailable
from .vault import (
    CredentialNotFound,
    RefreshLeaseHeld,
    RotationLost,
    RotationStoredButRefused,
)

if TYPE_CHECKING:
    from .audit import CredentialAuditRecorder
    from .provider import UpstreamRefusal
    from .rotating_vault import AsyncRotatingVault
    from .vault import RevisedCredential


@dataclass(frozen=True)
class RefreshTimings:
    expiry_margin_seconds: float = 60
    lease_seconds: float = 30
    wait_seconds: float = 45
    poll_seconds: float = 0.2


class GrantedAccess(TypedDict):
    access_token: str
    refresh_token: str
    expires_in: float


Grant = Callable[[Mapping[str, str]], Awaitable[GrantedAccess]]


@dataclass(frozen=True)
class _CachedAccess:
    token: str
    expires_at: float
    revision: str


@dataclass
class _RefreshLease:
    expires_at: float
    request_deadline: asyncio.Timeout | None = None


class RotatingAccess:
    def __init__(
        self,
        vault: Callable[[], AsyncRotatingVault],
        *,
        audit: CredentialAuditRecorder,
        grant: Grant,
        clock: Callable[[], float] = time.time,
        timings: RefreshTimings | None = None,
    ) -> None:
        self._vault = vault
        self._audit = audit
        self._grant = grant
        self._clock = clock
        self._timings = timings or RefreshTimings()
        self._access: dict[str, _CachedAccess] = {}
        self._refreshing: dict[str, asyncio.Lock] = {}

    async def store(self, account_id: str, sign_in: Mapping[str, str]) -> None:
        await self._vault().store(account_id, json.dumps(dict(sign_in)))
        self._access.pop(account_id, None)

    async def revoke(self, account_id: str) -> None:
        self._access.pop(account_id, None)
        await self._vault().delete(account_id)

    async def get(self, account_id: str, request_context: Mapping[str, str]) -> str:
        async with self._refreshing.setdefault(account_id, asyncio.Lock()):
            cached = self._access.get(account_id)
            if cached is not None and self._clock() < cached.expires_at:
                try:
                    revision = await self._vault().revision(account_id)
                except CredentialNotFound:
                    self._access.pop(account_id, None)
                    del cached
                    raise _no_credential() from None
                if revision == cached.revision:
                    return cached.token
                self._access.pop(account_id, None)
            del cached
            return await self._refresh(account_id, request_context)

    async def _refresh(self, account_id: str, request_context: Mapping[str, str]) -> str:
        vault = self._vault()
        lease = secrets.token_urlsafe()
        try:
            async with asyncio.timeout(self._timings.wait_seconds):
                stored, lease_expires_at = await self._leased(vault, account_id, lease, request_context)
        except TimeoutError:
            raise unavailable('another Credential Service task is still refreshing the ChatGPT credential') from None
        operation = asyncio.create_task(self._rotate_under_lease(vault, account_id, stored, lease, lease_expires_at))
        try:
            tokens, revision = await asyncio.shield(operation)
        except asyncio.CancelledError as cancelled:
            # Cancellation cannot abandon a thread holding a rotated token: retain custody until it settles.
            while not operation.done():
                try:
                    await asyncio.shield(operation)
                except asyncio.CancelledError:
                    continue
            raise (failure := operation.exception() or cancelled) from failure.__cause__
        except RotationStoredButRefused as error:
            raise unavailable('the Vault refused a write whose rotated ChatGPT credential was already stored') from error
        except RotationLost as error:
            raise unavailable('another write replaced the ChatGPT credential during its refresh') from error
        expires_at = self._clock() + tokens['expires_in'] - self._timings.expiry_margin_seconds
        self._access[account_id] = _CachedAccess(tokens['access_token'], expires_at, revision)
        return tokens['access_token']

    async def _rotate_under_lease(
        self, vault: AsyncRotatingVault, account_id: str, stored: RevisedCredential,
        lease: str, lease_expires_at: float,
    ) -> tuple[GrantedAccess, str]:
        active_lease = _RefreshLease(lease_expires_at)
        worker = asyncio.create_task(self._rotate(vault, account_id, stored, lease, active_lease))
        while True:
            await asyncio.wait({worker}, timeout=self._timings.lease_seconds / 3)
            if worker.done():
                return await worker
            renewal = await asyncio.gather(
                self._renew_under_lease(vault, account_id, stored.revision, lease, active_lease),
                return_exceptions=True,
            )
            failure = renewal[0]
            if isinstance(failure, BaseException):
                written = (await asyncio.gather(worker, return_exceptions=True))[0]
                if isinstance(written, BaseException):
                    raise unavailable('refresh lease renewal and credential write-back failed') from BaseExceptionGroup(
                        'Refresh renewal and write-back failed', [failure, written],
                    )
                if isinstance(failure, RotationLost) and failure.current_revision == written[1]:
                    return written
                raise failure
            active_lease.expires_at = failure
            if active_lease.request_deadline is not None:
                active_lease.request_deadline.reschedule(asyncio.get_running_loop().time() + failure - self._clock())

    async def _renew_under_lease(
        self, vault: AsyncRotatingVault, account_id: str, revision: str,
        lease: str, active_lease: _RefreshLease,
    ) -> float:
        expires_at = self._clock() + self._timings.lease_seconds
        # Only confirmation before the current expiry can extend the HTTP deadline.
        # A timed-out synchronous RPC may still finish; its owner/revision condition remains authoritative.
        try:
            async with asyncio.timeout(active_lease.expires_at - self._clock()):
                await vault.renew(
                    account_id,
                    revision=revision, lease=lease, expires_at=expires_at,
                )
        except TimeoutError as error:
            raise unavailable('the Vault did not confirm refresh lease renewal before its expiry') from error
        return expires_at

    async def _rotate(
        self, vault: AsyncRotatingVault, account_id: str, stored: RevisedCredential,
        lease: str, active_lease: _RefreshLease,
    ) -> tuple[GrantedAccess, str]:
        sign_in = json.loads(stored.value)
        try:
            async with asyncio.timeout(active_lease.expires_at - self._clock()) as deadline:
                active_lease.request_deadline = deadline
                tokens = await self._grant(sign_in)
        except TimeoutError as error:
            raise unavailable(f'OpenAI could not be reached for the token refresh: {type(error).__name__}') from None
        finally:
            active_lease.request_deadline = None
        rotated = json.dumps({**sign_in, 'refreshToken': tokens['refresh_token']})
        # The Vault's AWS clients retry transient failures (ADR 0030's transport choke point); none is retried here.
        try:
            revision = await vault.replace(
                account_id, rotated,
                revision=stored.revision, lease=lease,
            )
        except (RotationLost, RotationStoredButRefused):
            raise
        except Exception as error:
            raise unavailable('the Vault failed to store the rotated ChatGPT credential') from error
        return tokens, revision

    async def _leased(
        self, vault: AsyncRotatingVault, account_id: str, lease: str, request_context: Mapping[str, str],
    ) -> tuple[RevisedCredential, float]:
        """The credential under this refresh's lease, and when the lease expires (ADR 0078 decision 4).

        Only the lease holder spends the refresh token, so no refresh token is sent twice. A task that
        finds another lease waits for that lease's rotation, which it then refreshes in turn: access
        tokens stay in each task's memory, so it cannot use the other task's.
        """
        stored = await self._load(vault, account_id, request_context)
        while True:
            now = self._clock()
            expires_at = now + self._timings.lease_seconds
            try:
                await vault.take(
                    account_id,
                    revision=stored.revision,
                    lease=lease,
                    now=now,
                    expires_at=expires_at,
                )
            except CredentialNotFound:
                raise _no_credential() from None
            except RefreshLeaseHeld as held:
                if held.revision != stored.revision:
                    stored = await self._load(vault, account_id, request_context)
                else:
                    await asyncio.sleep(self._timings.poll_seconds)
                continue
            return stored, expires_at

    async def _load(
        self, vault: AsyncRotatingVault, account_id: str, request_context: Mapping[str, str],
    ) -> RevisedCredential:
        try:
            return await vault.load(account_id, self._audit, request_context)
        except CredentialNotFound:
            raise _no_credential() from None


def _no_credential() -> UpstreamRefusal:
    return revoked('no ChatGPT credential is stored for this account')
