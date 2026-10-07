"""Refresh completion and renewal failure race on the actual asyncio scheduler."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from botcube_credential_service.audit import CredentialAuditRecorder
from botcube_credential_service.openai import OpenAIProvider
from botcube_credential_service.provider import UpstreamRefusal
from botcube_credential_service.vault import DynamoDbCredentialVault, RotationLost
from test_openai import SIGN_IN, FakeOpenAI, _stored
from test_openai import vault as vault
from test_relay_network_timeouts import PacketClockLoop


@pytest.mark.parametrize(('response_delay', 'fails'), [(9, False), (12, True)])
def test_refresh_completion_observes_only_a_renewal_failure_that_has_started(
    vault: DynamoDbCredentialVault, monkeypatch: pytest.MonkeyPatch,
    response_delay: float, fails: bool,
) -> None:
    _stored(vault)
    upstream = FakeOpenAI()
    upstream.refresh_seconds = response_delay

    def refused_renewal(*args: Any, **kwargs: Any) -> None:
        raise RotationLost('The active lease could not be renewed')

    async def in_memory_vault_rpc(function: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        # Moto's Vault completes in memory. Keep its synchronous boundary on the
        # replay loop so thread scheduling cannot advance the virtual deadline.
        return function(*args, **kwargs)

    monkeypatch.setattr(vault, 'renew_refresh_lease', refused_renewal)
    monkeypatch.setattr(asyncio, 'to_thread', in_memory_vault_rpc)
    with asyncio.Runner(loop_factory=PacketClockLoop) as runner:
        provider = OpenAIProvider(
            lambda: vault, audit=CredentialAuditRecorder(),
            transport=httpx.MockTransport(upstream.handle), clock=runner.get_loop().time,
        )
        if fails:
            with pytest.raises(UpstreamRefusal) as failure:
                runner.run(provider.mint_access('acct-1', {}))
            assert failure.value.status_code == 503
        else:
            assert runner.run(provider.mint_access('acct-1', {})) == 'at_1'
    assert upstream.spent == {SIGN_IN['refreshToken']}
