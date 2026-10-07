from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .invocation import (
    CredentialServiceInvocation,
    verify_credential_service_invocation,
)
from .provider import CredentialProvider, UpstreamRefusal

_LOG = logging.getLogger(__name__)

CREDENTIAL_CAPTURE_SCOPE = 'credential_capture'
CREDENTIAL_REVOCATION_SCOPE = 'credential_revocation'


@dataclass(frozen=True)
class CredentialServiceSettings:
    """What the Cartridge composing the Credential Service names."""

    # The service name /health answers.
    name: str
    invocation_secret: Callable[[], str]
    # The headers callers name the invoking account and Session in.
    account_header: str
    session_header: str
    # Trusted deployment owner for Plan Usage; other providers remain unrestricted.
    plan_usage_owner_account_id: str = ''


class InvocationGuard:
    """Verifies the signed invocation token every Credential Service call carries (ADR 0036)."""

    def __init__(self, secret: Callable[[], str]) -> None:
        self._secret = secret

    def configured(self) -> bool:
        return bool(self._secret().strip())

    def verify(self, authorization: str | None, *, required_scope: str | None = None) -> CredentialServiceInvocation:
        expected = self._secret().strip()
        if not expected:
            raise HTTPException(status_code=503, detail='CredentialService invocation token is not configured')
        prefix = 'Bearer '
        actual = authorization[len(prefix):].strip() if authorization and authorization.startswith(prefix) else ''
        invocation = verify_credential_service_invocation(expected, actual)
        if invocation is None:
            raise HTTPException(status_code=401, detail='Invalid Credential Service invocation token')
        if required_scope is not None:
            if invocation.scope != required_scope:
                raise HTTPException(
                    status_code=401,
                    detail=f'This call requires a {required_scope}-scoped Credential Service invocation token',
                )
        elif invocation.scope is not None:
            raise HTTPException(status_code=401, detail='Invalid Credential Service invocation token')
        return invocation

    def verify_account(
        self, authorization: str | None, account_header: str | None, scope: str | None,
    ) -> CredentialServiceInvocation:
        invocation = self.verify(authorization, required_scope=scope)
        header_account_id = (account_header or '').strip()
        if header_account_id and header_account_id != invocation.account_id:
            raise HTTPException(status_code=401, detail='Invalid Credential Service invocation token')
        return invocation


def request_context(invocation: CredentialServiceInvocation, method: str, path: str) -> dict[str, str]:
    """The audit fields of one call: its Session, method, path and scope."""
    context = {
        'sessionId': invocation.session_id,
        'method': method.upper(),
        'path': path.lstrip('/'),
    }
    if invocation.scope is not None:
        context['scope'] = invocation.scope
    return context


def create_app(settings: CredentialServiceSettings, providers: Sequence[CredentialProvider[Any]]) -> FastAPI:
    app = FastAPI(title='Credential Service')
    guard = InvocationGuard(settings.invocation_secret)

    @app.exception_handler(UpstreamRefusal)
    async def upstream_refusal(request: Request, refusal: UpstreamRefusal) -> Response:
        return JSONResponse(dict(refusal.body), status_code=refusal.status_code)

    @app.get('/health')
    def health() -> dict[str, str]:
        if not guard.configured():
            raise HTTPException(
                status_code=503,
                detail={'code': 'credential_service_unconfigured', 'component': 'invocation_auth'},
            )
        try:
            for provider in providers:
                provider.ready()
        except (HTTPException, ValueError):
            raise HTTPException(
                status_code=503,
                detail={'code': 'credential_service_unconfigured', 'component': 'vault'},
            ) from None
        return {'status': 'ok', 'service': settings.name}

    @app.post('/account/revoke')
    async def revoke_account(request: Request) -> dict[str, str]:
        """Account deletion: revoke the account at every provider, so no Durable Credential outlives it."""
        invocation = guard.verify_account(
            request.headers.get('authorization'), request.headers.get(settings.account_header), CREDENTIAL_REVOCATION_SCOPE,
        )
        for provider in providers:
            await provider.revoke(invocation.account_id)
        return {'status': 'revoked'}

    for provider in providers:
        _mount(app, settings, guard, provider)
    return app


def _mount(
    app: FastAPI, settings: CredentialServiceSettings, guard: InvocationGuard, provider: CredentialProvider[Any],
) -> None:
    prefix = f'/{provider.name}'

    @app.post(f'{prefix}/auth/link/ingest')
    async def ingest(payload: dict[str, Any], request: Request) -> dict[str, str]:
        invocation = guard.verify_account(
            request.headers.get('authorization'), request.headers.get(settings.account_header), CREDENTIAL_CAPTURE_SCOPE,
        )
        _require_plan_usage_owner(settings, provider, invocation)
        return dict(await provider.ingest(invocation, payload))

    @app.post(f'{prefix}/auth/link/revoke')
    async def revoke(request: Request) -> dict[str, str]:
        invocation = guard.verify_account(
            request.headers.get('authorization'), request.headers.get(settings.account_header), CREDENTIAL_REVOCATION_SCOPE,
        )
        _require_plan_usage_owner(settings, provider, invocation)
        await provider.revoke(invocation.account_id)
        return {'status': 'revoked'}

    app.include_router(provider.routes(guard), prefix=prefix)

    @app.api_route(prefix + '/{path:path}', methods=['GET', 'POST', 'PUT', 'DELETE'])
    async def relay(path: str, request: Request) -> Response:
        invocation = guard.verify_account(
            request.headers.get('authorization'), request.headers.get(settings.account_header), None,
        )
        session_id = (request.headers.get(settings.session_header) or '').strip()
        if not session_id or session_id != invocation.session_id:
            raise HTTPException(status_code=401, detail='Invalid Credential Service invocation token')
        method, upstream_path = request.method.upper(), path.lstrip('/')
        if not provider.allows_upstream(method, upstream_path):
            _LOG.warning('Credential Service refused upstream %s %s', method, upstream_path)
            raise HTTPException(status_code=403, detail=f'Credential Service only allows {provider.upstream_scope}')
        await provider.authorize_upstream(invocation, request, upstream_path)
        context = request_context(invocation, request.method, path)
        access = await provider.mint_access(invocation.account_id, context)
        return await provider.relay(request, path, access, account_id=invocation.account_id, request_context=context)


def _require_plan_usage_owner(
    settings: CredentialServiceSettings, provider: CredentialProvider[Any], invocation: CredentialServiceInvocation,
) -> None:
    if not provider.owner_only:
        return
    owner = settings.plan_usage_owner_account_id.strip()
    if not owner:
        raise HTTPException(status_code=503, detail='Plan Usage owner account is not configured')
    if invocation.account_id != owner:
        raise HTTPException(status_code=403, detail='Plan Usage is only available to the configured owner account')
