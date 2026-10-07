from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, Protocol, TypeVar

if TYPE_CHECKING:
    from fastapi import APIRouter, Request
    from fastapi.responses import Response

    from .invocation import CredentialServiceInvocation
    from .server import InvocationGuard

Access = TypeVar('Access')


class UpstreamRefusal(Exception):
    """A provider's refusal of an upstream call, answered in the upstream's own error shape.

    `mint_access` raises it when it cannot mint access, so the caller's upstream client reads
    the refusal as it reads the upstream's errors.
    """

    def __init__(self, status_code: int, body: Mapping[str, Any]) -> None:
        super().__init__(f'HTTP {status_code}: {body}')
        self.status_code = status_code
        self.body = body


class CredentialProvider(Protocol[Access]):
    """What differs per provider whose Durable Credential the Credential Service holds (ADR 0078 decision 2).

    The Credential Service verifies every invocation before calling a provider, and serves the
    provider's routes under `/{name}`.
    """

    name: str
    # Completes "Credential Service only allows ..." when an upstream call is refused.
    upstream_scope: str
    # Only the deployment owner's account may ingest or revoke its Durable Credential (ADR 0078 decision 5).
    owner_only: bool

    def ready(self) -> None:
        """Raise ValueError when the provider's Vault configuration is unusable."""
        ...

    async def ingest(self, invocation: CredentialServiceInvocation, payload: Mapping[str, Any]) -> Mapping[str, str]:
        """Validate a captured Durable Credential, store it in the Vault, and answer the response body."""
        ...

    async def revoke(self, account_id: str) -> None:
        """Delete the account's Durable Credential and any access minted from it."""
        ...

    def allows_upstream(self, method: str, path: str) -> bool:
        """Whether access may be attached to this upstream call; `path` has no leading slash."""
        ...

    async def authorize_upstream(self, invocation: CredentialServiceInvocation, request: Request, path: str) -> None:
        """Reject requests outside the signed invocation's provider policy before minting access."""
        ...

    async def mint_access(self, account_id: str, request_context: Mapping[str, str]) -> Access:
        """Short-lived access for the account, minted from its Durable Credential when none is cached."""
        ...

    async def relay(
        self,
        request: Request,
        path: str,
        access: Access,
        *,
        account_id: str,
        request_context: Mapping[str, str],
    ) -> Response:
        """Send an allowed upstream call with the account's access attached, and answer the upstream response."""
        ...

    def routes(self, guard: InvocationGuard) -> APIRouter:
        """The provider's own routes, beyond ingest, revoke and relay."""
        ...
