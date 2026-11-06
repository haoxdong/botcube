from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import TYPE_CHECKING

from fastapi import APIRouter, Header, HTTPException

from .server import InvocationGuard, request_context

if TYPE_CHECKING:
    from .audit import CredentialAuditRecorder
    from .vault import DynamoDbCredentialVault


def test_connector_routes(
    guard: InvocationGuard, vault: Callable[[], DynamoDbCredentialVault], provider: str,
    owner: Callable[[], str], audit: CredentialAuditRecorder,
) -> APIRouter:
    router = APIRouter()

    @router.post('/auth/test-user-copy')
    async def copy(authorization: str | None = Header(None)) -> dict[str, str]:
        invocation = guard.verify(authorization, required_scope='test_user_copy')
        source = owner().strip()
        if not source:
            raise HTTPException(status_code=503, detail='Test User credential owner is not configured')
        await asyncio.to_thread(vault().copy_test_connector, source, invocation.account_id, provider,
                                audit=audit, request_context=request_context(invocation, 'POST', 'auth/test-user-copy'))
        return {'status': 'stored'}

    return router
