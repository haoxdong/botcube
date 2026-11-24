"""Refresh-token custody through the async Vault and grant interfaces."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Coroutine, Mapping
from dataclasses import dataclass
from itertools import count
from typing import Any, TypeVar

import pytest

from botcube_credential_service.audit import CredentialAuditRecorder
from botcube_credential_service.openai_errors import revoked, unavailable
from botcube_credential_service.provider import UpstreamRefusal
from botcube_credential_service.rotating_access import (
    Grant,
    GrantedAccess,
    RefreshTimings,
    RotatingAccess,
)
from botcube_credential_service.vault import (
    CredentialNotFound,
    RefreshLeaseHeld,
    RevisedCredential,
    RotationLost,
)
from test_openai import SIGN_IN
from test_relay_network_timeouts import PacketClockLoop


@dataclass
class Row:
    credential: RevisedCredential
    lease_id: str | None = None
    expires_at: float = 0


class MemoryVault:
    def __init__(self) -> None:
        self.rows = {'acct-1': Row(RevisedCredential(json.dumps(SIGN_IN), '0'))}
        self.revisions = count(1)

    async def store(self, account_id: str, value: str) -> None:
        self.rows[account_id] = Row(RevisedCredential(value, str(next(self.revisions))))

    async def delete(self, account_id: str) -> None:
        self.rows.pop(account_id, None)

    async def revision(self, account_id: str) -> str:
        return self._row(account_id).credential.revision

    async def load(
        self, account_id: str, audit: CredentialAuditRecorder, request_context: Mapping[str, str],
    ) -> RevisedCredential:
        return self._row(account_id).credential

    async def take(self, account_id: str, *, revision: str, lease: str, now: float, expires_at: float) -> None:
        row = self._row(account_id)
        if row.credential.revision != revision or (row.lease_id is not None and row.expires_at > now):
            raise RefreshLeaseHeld(row.credential.revision)
        row.lease_id, row.expires_at = lease, expires_at

    async def renew(self, account_id: str, *, revision: str, lease: str, expires_at: float) -> None:
        self._held(account_id, revision, lease).expires_at = expires_at

    async def replace(self, account_id: str, value: str, *, revision: str, lease: str) -> str:
        self._held(account_id, revision, lease)
        await self.store(account_id, value)
        return await self.revision(account_id)

    def sign_in(self) -> dict[str, str]:
        return json.loads(self._row('acct-1').credential.value)

    def _row(self, account_id: str) -> Row:
        if account_id not in self.rows:
            raise CredentialNotFound()
        return self.rows[account_id]

    def _held(self, account_id: str, revision: str, lease: str) -> Row:
        row = self.rows.get(account_id)
        current = row.credential.revision if row else None
        if row is None or current != revision or row.lease_id != lease:
            raise RotationLost('The active lease was lost', current_revision=current)
        return row


class FakeGrant:
    def __init__(self, delay: float) -> None:
        self.delay = delay
        self.spent: list[str] = []
        self.tokens = iter([
            GrantedAccess(access_token='at_1', refresh_token='rt_second', expires_in=300),
            GrantedAccess(access_token='at_2', refresh_token='rt_third', expires_in=300),
        ])

    async def __call__(self, sign_in: Mapping[str, str]) -> GrantedAccess:
        refresh_token = sign_in['refreshToken']
        assert refresh_token not in self.spent
        self.spent.append(refresh_token)
        tokens = next(self.tokens)
        await asyncio.sleep(self.delay)
        return tokens


def make_access(vault: MemoryVault, grant: Grant, *, lease_seconds: float = 30) -> RotatingAccess:
    return RotatingAccess(
        lambda: vault, audit=CredentialAuditRecorder(), grant=grant, clock=asyncio.get_running_loop().time,
        timings=RefreshTimings(lease_seconds=lease_seconds, poll_seconds=0.005),
    )


T = TypeVar('T')


def run_virtual(operation: Coroutine[Any, Any, T]) -> T:
    with asyncio.Runner(loop_factory=PacketClockLoop) as runner:
        return runner.run(operation)


@pytest.mark.parametrize(('response_delay', 'fails'), [(9, False), (12, True)])
def test_refresh_completion_observes_only_a_renewal_failure_that_has_started(response_delay: float, fails: bool) -> None:
    class RefusesRenewal(MemoryVault):
        async def renew(self, account_id: str, *, revision: str, lease: str, expires_at: float) -> None:
            raise RotationLost('The active lease could not be renewed')

    async def run() -> None:
        grant = FakeGrant(response_delay)
        access = make_access(RefusesRenewal(), grant)
        if fails:
            with pytest.raises(UpstreamRefusal) as failure:
                await access.get('acct-1', {})
            assert failure.value.status_code == 503
        else:
            assert await access.get('acct-1', {}) == 'at_1'
        assert grant.spent == ['rt_first']

    run_virtual(run())


@pytest.mark.parametrize(('renewal_fails', 'renewal_delay'), [(False, 0), (False, 0.1), (True, 0)])
def test_slow_consumed_refresh_response_obeys_the_active_lease(renewal_fails: bool, renewal_delay: float) -> None:
    class DelayedRenewal(MemoryVault):
        async def renew(self, account_id: str, *, revision: str, lease: str, expires_at: float) -> None:
            if renewal_fails:
                raise RotationLost('The active lease could not be renewed')
            await asyncio.sleep(renewal_delay)
            await super().renew(account_id, revision=revision, lease=lease, expires_at=expires_at)

    async def run() -> None:
        vault = DelayedRenewal()
        grant = FakeGrant(0.75)
        access = make_access(vault, grant, lease_seconds=0.5)
        if renewal_fails:
            with pytest.raises(UpstreamRefusal) as failure:
                await access.get('acct-1', {})
            assert failure.value.status_code == 503
            assert failure.value.body['error']['code'] == 'PLAN_USAGE_UNAVAILABLE'
            assert vault.sign_in() == SIGN_IN
            assert grant.spent == ['rt_first']
        else:
            assert await access.get('acct-1', {}) == 'at_1'
            assert vault.sign_in()['refreshToken'] == 'rt_second'
            peer = make_access(vault, grant, lease_seconds=0.5)
            assert await peer.get('acct-1', {}) == 'at_2'
            assert grant.spent == ['rt_first', 'rt_second']
            assert vault.sign_in()['refreshToken'] == 'rt_third'

    run_virtual(run())


@pytest.mark.parametrize('stored_before_response', [False, True])
@pytest.mark.parametrize('cancel_request', [False, True])
def test_two_tasks_do_not_spend_the_same_refresh_token_during_slow_write_back(
    stored_before_response: bool, cancel_request: bool,
) -> None:
    async def run() -> None:
        entered, release = asyncio.Event(), asyncio.Event()

        class SlowWrite(MemoryVault):
            async def replace(self, account_id: str, value: str, *, revision: str, lease: str) -> str:
                if entered.is_set():
                    return await super().replace(account_id, value, revision=revision, lease=lease)
                if stored_before_response:
                    written = await super().replace(account_id, value, revision=revision, lease=lease)
                    entered.set()
                    await release.wait()
                    return written
                entered.set()
                await release.wait()
                return await super().replace(account_id, value, revision=revision, lease=lease)

        vault, grant = SlowWrite(), FakeGrant(0)
        first = make_access(vault, grant, lease_seconds=0.5)
        second = make_access(vault, grant, lease_seconds=0.5)
        initial = asyncio.create_task(first.get('acct-1', {}))
        await asyncio.wait_for(entered.wait(), 1)
        if cancel_request:
            initial.cancel()
        await asyncio.sleep(0.75)
        waiting = asyncio.create_task(second.get('acct-1', {}))
        await asyncio.sleep(0.2)
        release.set()
        results = await asyncio.gather(initial, waiting, return_exceptions=True)
        if cancel_request:
            assert isinstance(results[0], asyncio.CancelledError)
        else:
            assert results[0] == 'at_1'
        assert results[1] == 'at_2'
        assert grant.spent == ['rt_first', 'rt_second']
        assert vault.sign_in() == {**SIGN_IN, 'refreshToken': 'rt_third'}

    run_virtual(run())


@pytest.mark.parametrize('cancellations', [0, 1, 2])
def test_repeated_request_cancellation_keeps_custody_of_a_consumed_refresh(cancellations: int) -> None:
    async def run() -> None:
        consumed = asyncio.Event()

        class SlowConsumedGrant(FakeGrant):
            async def __call__(self, sign_in: Mapping[str, str]) -> GrantedAccess:
                consumed.set()
                return await super().__call__(sign_in)

        vault, grant = MemoryVault(), SlowConsumedGrant(1.1)
        first = make_access(vault, grant, lease_seconds=0.6)
        second = make_access(vault, grant, lease_seconds=0.6)
        initial = asyncio.create_task(first.get('acct-1', {}))
        await asyncio.wait_for(consumed.wait(), 2)
        for _ in range(cancellations):
            initial.cancel()
            await asyncio.sleep(0)
        [outcome] = await asyncio.gather(initial, return_exceptions=True)
        if cancellations:
            assert isinstance(outcome, asyncio.CancelledError)
        else:
            assert outcome == 'at_1'
        assert await second.get('acct-1', {}) == 'at_2'
        assert grant.spent == ['rt_first', 'rt_second']
        assert vault.sign_in()['refreshToken'] == 'rt_third'

    run_virtual(run())


def test_a_slow_refresh_for_one_account_does_not_block_another_accounts_access() -> None:
    async def run() -> None:
        vault, grant = MemoryVault(), FakeGrant(0)
        await vault.store('acct-2', json.dumps({**SIGN_IN, 'refreshToken': 'rt_other'}))
        entered, release = asyncio.Event(), asyncio.Event()

        async def wait_for_first(sign_in: Mapping[str, str]) -> GrantedAccess:
            if sign_in['refreshToken'] == 'rt_first':
                entered.set()
                await release.wait()
            return await grant(sign_in)

        access = make_access(vault, wait_for_first)
        first = asyncio.create_task(access.get('acct-1', {}))
        try:
            await asyncio.wait_for(entered.wait(), 1)
            assert await asyncio.wait_for(access.get('acct-2', {}), 1) == 'at_1'
        finally:
            release.set()
            first_token = await first
        assert first_token == 'at_2'
        assert grant.spent == ['rt_other', 'rt_first']

    run_virtual(run())


@pytest.mark.parametrize('worker_refused,renewed_once', [(False, False), (True, False), (False, True)])
def test_a_failed_lease_renewal_cannot_accept_an_unrelated_write_or_hide_a_refresh_failure(
    worker_refused: bool, renewed_once: bool,
) -> None:
    async def run() -> tuple[UpstreamRefusal, MemoryVault, FakeGrant, RotationLost]:
        release = asyncio.Event()
        renewal_failure = RotationLost('another holder owns the lease', current_revision='unrelated-revision')
        renewals = 0

        class RefusesRenewal(MemoryVault):
            async def renew(self, account_id: str, *, revision: str, lease: str, expires_at: float) -> None:
                nonlocal renewals
                renewals += 1
                if renewed_once and renewals == 1:
                    await super().renew(account_id, revision=revision, lease=lease, expires_at=expires_at)
                    return
                release.set()
                raise renewal_failure

        vault, grant = RefusesRenewal(), FakeGrant(0)

        async def wait_for_renewal(sign_in: Mapping[str, str]) -> GrantedAccess:
            await release.wait()
            if renewed_once:
                await asyncio.sleep(0.2)
            if worker_refused:
                raise unavailable('grant refused')
            return await grant(sign_in)

        access = make_access(vault, wait_for_renewal, lease_seconds=0.06)
        with pytest.raises(UpstreamRefusal) as caught:
            await access.get('acct-1', {})
        return caught.value, vault, grant, renewal_failure

    refusal, vault, grant, renewal_failure = run_virtual(run())
    cause = refusal.__cause__
    assert refusal.status_code == 503
    assert refusal.body['error']['code'] == 'PLAN_USAGE_UNAVAILABLE'
    if worker_refused or renewed_once:
        assert 'refresh lease renewal and credential write-back failed' in str(refusal)
        assert isinstance(cause, BaseExceptionGroup)
        assert cause.exceptions[0] is renewal_failure
        assert isinstance(cause.exceptions[1], UpstreamRefusal)
        if renewed_once:
            assert 'TimeoutError' in str(cause.exceptions[1])
            assert grant.spent == []
    else:
        assert 'another write replaced the ChatGPT credential during its refresh' in str(refusal)
        assert cause is renewal_failure
        assert vault.sign_in()['refreshToken'] == 'rt_second'



def test_stalled_renewal_does_not_delay_the_confirmed_lease_failure() -> None:
    async def run() -> None:
        consumed, grant_cancelled, release_renewal = asyncio.Event(), asyncio.Event(), asyncio.Event()
        pending: list[asyncio.Task[None]] = []
        outcomes: list[None | BaseException] = []

        class StalledRenewal(MemoryVault):
            async def renew(self, account_id: str, *, revision: str, lease: str, expires_at: float) -> None:
                complete = super().renew

                async def late_renewal() -> None:
                    await release_renewal.wait()
                    await complete(account_id, revision=revision, lease=lease, expires_at=expires_at)

                pending.append(asyncio.create_task(late_renewal()))
                await asyncio.shield(pending[-1])

        async def grant(sign_in: Mapping[str, str]) -> GrantedAccess:
            assert sign_in == SIGN_IN
            if consumed.is_set():
                raise revoked('refresh token already consumed')
            consumed.set()
            try:
                await asyncio.sleep(2)
            except asyncio.CancelledError:
                grant_cancelled.set()
                raise
            pytest.fail('grant exceeded the confirmed lease deadline')

        vault = StalledRenewal()
        first = make_access(vault, grant, lease_seconds=0.5)
        second = make_access(vault, grant, lease_seconds=0.5)
        try:
            with pytest.raises(UpstreamRefusal) as failed:
                await asyncio.wait_for(first.get('acct-1', {}), 1)
            assert failed.value.status_code == 503
            assert grant_cancelled.is_set()
            [late] = pending
            assert not late.done()
            with pytest.raises(UpstreamRefusal) as peer:
                await second.get('acct-1', {})
            assert peer.value.status_code == 401
        finally:
            release_renewal.set()
            if pending:
                outcomes = await asyncio.gather(*pending, return_exceptions=True)
        assert len(outcomes) == 1
        assert isinstance(outcomes[0], RotationLost)
        assert vault.sign_in() == SIGN_IN
        cause = failed.value.__cause__
        assert isinstance(cause, BaseExceptionGroup)
        assert len(cause.exceptions) == 2
        renewal, grant_failure = cause.exceptions
        assert isinstance(renewal, UpstreamRefusal)
        assert renewal.status_code == 503
        assert isinstance(renewal.__cause__, TimeoutError)
        assert isinstance(grant_failure, UpstreamRefusal)
        assert grant_failure.status_code == 503

    run_virtual(run())


@pytest.mark.parametrize('cancellations', [1, 2])
def test_cancelled_refresh_propagates_a_custody_failure_with_its_cause(cancellations: int) -> None:
    async def run() -> None:
        entered, release = asyncio.Event(), asyncio.Event()

        class RefusesWrite(MemoryVault):
            async def replace(self, account_id: str, value: str, *, revision: str, lease: str) -> str:
                entered.set()
                await release.wait()
                raise RuntimeError('synthetic persistence refusal')

        access = make_access(RefusesWrite(), FakeGrant(0))
        initial = asyncio.create_task(access.get('acct-1', {}))
        await asyncio.wait_for(entered.wait(), 1)
        for _ in range(cancellations):
            initial.cancel()
            await asyncio.sleep(0)
        release.set()
        with pytest.raises(UpstreamRefusal, match='Vault failed to store the rotated ChatGPT credential') as failed:
            await initial
        assert isinstance(failed.value.__cause__, RuntimeError)
        assert str(failed.value.__cause__) == 'synthetic persistence refusal'

    run_virtual(run())
