from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from botcube_credential_service.invocation import CredentialServiceInvocation
from botcube_credential_service.provider import UpstreamRefusal
from botcube_credential_service.server import CREDENTIAL_CAPTURE_SCOPE, InvocationGuard
from botcube_credential_service.vault import CredentialNotFound, CredentialVault


class FakeSiteProvider:
    name = 'fake-site'
    upstream_scope = 'GET /data on the template site'
    owner_only = False

    def __init__(self, vault: Callable[[], CredentialVault], site_url: str) -> None:
        self._vault = vault
        self._site_url = site_url.rstrip('/')

    def ready(self) -> None:
        self._vault()
        if not self._site_url:
            raise ValueError('Template site URL is required')

    async def ingest(self, invocation: CredentialServiceInvocation, payload: Mapping[str, Any]) -> Mapping[str, str]:
        credential = payload.get('credential')
        if not isinstance(credential, str) or not credential:
            raise HTTPException(400, 'A captured template credential is required')
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(f'{self._site_url}/data', headers={'Authorization': f'Bearer {credential}'})
        if response.status_code != 200:
            raise HTTPException(401, 'Template sign-in was refused')
        self._vault().store_durable_credential(invocation.account_id, self.name, credential)
        return {'status': 'linked'}

    async def revoke(self, account_id: str) -> None:
        self._vault().delete_durable_credential(account_id, self.name)

    def allows_upstream(self, method: str, path: str) -> bool:
        return (method, path) == ('GET', 'data')

    async def authorize_upstream(self, invocation: CredentialServiceInvocation, request: Request, path: str) -> None:
        if request.url.query:
            raise HTTPException(403, 'Template data does not accept query parameters')

    async def mint_access(self, account_id: str, request_context: Mapping[str, str]) -> str:
        try:
            credential = self._vault().load_durable_credential(account_id, self.name, request_context=request_context)
        except CredentialNotFound as error:
            raise UpstreamRefusal(401, {'code': 'SIGN_IN_NEEDED', 'error': 'Template site sign-in needed'}) from error
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(f'{self._site_url}/access', headers={'Authorization': f'Bearer {credential}'})
        if response.status_code != 200:
            raise UpstreamRefusal(response.status_code, {'code': 'SIGN_IN_NEEDED', 'error': 'Template site refused access'})
        access = response.json().get('access')
        if not isinstance(access, str) or not access:
            raise HTTPException(502, 'Template site returned malformed access')
        return access

    async def relay(
        self, request: Request, path: str, access: str, *, account_id: str, request_context: Mapping[str, str],
    ) -> Response:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(f'{self._site_url}/data', headers={'Authorization': f'Bearer {access}'})
        return Response(content=response.content, status_code=response.status_code, media_type='application/json')

    def routes(self, guard: InvocationGuard) -> APIRouter:
        router = APIRouter()

        @router.post('/auth/link/sign-in')
        async def sign_in(request: Request) -> Mapping[str, str]:
            invocation = guard.verify(request.headers.get('authorization'), required_scope=CREDENTIAL_CAPTURE_SCOPE)
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.post(f'{self._site_url}/login')
            if response.status_code != 200:
                raise HTTPException(502, 'Template site sign-in failed')
            return await self.ingest(invocation, response.json())

        @router.get('/auth/status')
        def status(request: Request) -> dict[str, str]:
            invocation = guard.verify(request.headers.get('authorization'))
            try:
                self._vault().load_credential_revision(invocation.account_id, self.name)
            except CredentialNotFound:
                return {'status': 'not_linked'}
            return {'status': 'linked'}

        return router
