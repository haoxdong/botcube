from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping, Sequence
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from botcube_credential_service.audit import CredentialAuditRecorder
from botcube_credential_service.invocation import CredentialServiceInvocation
from botcube_credential_service.provider import UpstreamRefusal
from botcube_credential_service.server import CREDENTIAL_CAPTURE_SCOPE, InvocationGuard
from botcube_credential_service.sessions import SessionCache, SessionVault
from botcube_credential_service.vault import CredentialNotFound

_SIGN_IN_NEEDED = {'code': 'SIGN_IN_NEEDED', 'error': 'Template site sign-in needed'}


class FakeSiteProvider:
    """The template site: its Durable Credential is a sign-in credential, its session a short-lived access token."""

    name = 'fake-site'
    upstream_scope = 'GET /data on the template site'
    owner_only = False

    def __init__(
        self, vault: Callable[[], SessionVault], site_url: str, audit: CredentialAuditRecorder | None = None,
    ) -> None:
        self._vault = vault
        self._site_url = site_url.rstrip('/')
        self._audit = audit
        self._sessions: SessionCache | None = None

    def sessions(self) -> SessionCache:
        if self._sessions is None:
            self._sessions = SessionCache(
                vault=self._vault(), reminter=self._remint, provider=self.name, site='template site',
                live=_has_access, audit=self._audit,
            )
        return self._sessions

    def _remint(self, credential: str) -> Mapping[str, Any]:
        response = httpx.post(f'{self._site_url}/access', headers={'Authorization': f'Bearer {credential}'}, timeout=10)
        if response.status_code != 200:
            raise UpstreamRefusal(response.status_code, {'code': 'SIGN_IN_NEEDED', 'error': 'Template site refused access'})
        body = response.json()
        access, expires = body.get('access'), body.get('expiresAt')
        if not isinstance(access, str) or not access or not isinstance(expires, int | float):
            raise HTTPException(502, 'Template site returned malformed access')
        return {'cookies': [{'name': 'access', 'value': access, 'expires': expires}]}

    async def aclose(self) -> None:
        return None

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
        await asyncio.to_thread(self.sessions().store_linked_credential, invocation.account_id, credential, [])
        return {'status': 'linked'}

    async def revoke(self, account_id: str) -> None:
        await asyncio.to_thread(self.sessions().delete_linked_credential, account_id)

    def allows_upstream(self, method: str, path: str) -> bool:
        return (method, path) == ('GET', 'data')

    async def authorize_upstream(self, invocation: CredentialServiceInvocation, request: Request, path: str) -> None:
        if request.url.query:
            raise HTTPException(403, 'Template data does not accept query parameters')

    async def mint_access(self, account_id: str, request_context: Mapping[str, str]) -> list[object]:
        try:
            jar = await asyncio.to_thread(self.sessions().session_cookie_jar, account_id, request_context)
        except CredentialNotFound as error:
            raise UpstreamRefusal(401, _SIGN_IN_NEEDED) from error
        return jar['cookies']

    async def relay(
        self, request: Request, path: str, access: list[object], *, account_id: str, request_context: Mapping[str, str],
    ) -> Response:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(f'{self._site_url}/data', headers={'Authorization': f'Bearer {_token(access)}'})
            if response.status_code == 401:
                # The site ended the session early: re-mint once from the Durable Credential.
                await asyncio.to_thread(self.sessions().invalidate_session, account_id, expected_cookies=access)
                access = await self.mint_access(account_id, request_context)
                response = await client.get(f'{self._site_url}/data', headers={'Authorization': f'Bearer {_token(access)}'})
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


def _has_access(cookies: Sequence[object], now: float) -> bool:
    return any(
        isinstance(cookie, Mapping) and cookie.get('name') == 'access' and isinstance(cookie.get('expires'), int | float)
        and cookie['expires'] > now
        for cookie in cookies
    )


def _token(access: Sequence[object]) -> str:
    return next(str(cookie['value']) for cookie in access if isinstance(cookie, Mapping) and cookie.get('name') == 'access')
