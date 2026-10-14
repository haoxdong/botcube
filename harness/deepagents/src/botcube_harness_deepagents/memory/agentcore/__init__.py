"""AgentCore Memory under the Session's credentials (ADR 0067 §8).

The Chat Service signs a per-Turn JWT tagged with the Turn's actor, the Session's filing
actor and the Session. STS ``AssumeRoleWithWebIdentity`` turns it into credentials of the
Memory role, whose policy reads those tags. A Turn whose JWT carries the tags of credentials
already held, more than 5 minutes from expiry, reuses them and calls no STS. The microVM's one
``bedrock-agentcore`` client signs with the newest credentials and serves its checkpointer,
store, ``memory`` tool, Pending Memory and turn feed, so Turns reuse its open connections. The
Agent Service's own role holds no Memory permission.
"""

from __future__ import annotations

import base64
import itertools
import json
import os
import re
import threading
from datetime import UTC, datetime, timedelta
from typing import Any

import boto3
import botocore.session
from botocore import UNSIGNED
from botocore.config import Config
from botocore.credentials import (
    CredentialProvider,
    CredentialResolver,
    Credentials,
    ReadOnlyCredentials,
)
from botocore.exceptions import ClientError
from langgraph_checkpoint_aws import AgentCoreMemorySaver, AgentCoreMemoryStore

from ...memory_document import opening_memory
from ...memory_tools import memory_tool
from ...session_memory import SessionMemoryMiddleware
from ...turn_memory import TurnMemoryMiddleware
from .warm_session import WarmSessionSaver

__all__ = [
    'MemorySandboxError', 'TurnIdentityError', 'build_checkpointer', 'build_memory_tools', 'build_store',
    'finished_snapshot_epoch', 'is_access_denied', 'next_turn', 'opening',
    'turn_memory',
]

USER_MEMORY_ROLE_ARN = os.getenv('BOTCUBE_USER_MEMORY_ROLE_ARN', '')
# What STS answers a JWT it refuses: a bad signature, issuer or audience, an expired token, or a refused claim.
_REFUSED_IDENTITY = frozenset({'InvalidIdentityToken', 'ExpiredTokenException', 'IDPRejectedClaim'})
_MEMORY_OPERATIONS = frozenset(botocore.session.get_session().get_service_model('bedrock-agentcore').operation_names)
_TAGS_CLAIM = 'https://aws.amazon.com/tags'
# Live, a Turn's opening Memory read, history read and turn feed overlapped 12 calls.
_MEMORY_CONNECTIONS = 16
# A Turn exchanges its JWT again when the credentials held for its tags expire within this.
_REUSE_MARGIN = timedelta(minutes=5)


class TurnIdentityError(RuntimeError):
    """The invocation's per-Turn JWT is missing, or STS refused it."""

    code = 'TURN_IDENTITY_REJECTED'


class MemorySandboxError(TurnIdentityError):
    """A Turn's identity names another Session sandbox than the one this microVM's Memory client serves."""

    code = 'MEMORY_SANDBOX_MISMATCH'


def is_access_denied(error: BaseException) -> bool:
    """Whether AgentCore Memory refused a call outside the Turn credentials' tagged scope."""
    return (
        isinstance(error, ClientError)
        and error.response.get('Error', {}).get('Code') == 'AccessDeniedException'
        and error.operation_name in _MEMORY_OPERATIONS
    )


def build_checkpointer(memory_id: str, *, region_name: str) -> AgentCoreMemorySaver:
    """The stock saver in snapshot format, as shipped (ADR 0067 decision 9)."""
    return AgentCoreMemorySaver(memory_id, checkpoint_format='snapshot', limit=None, region_name=region_name)


def build_store(memory_id: str, *, region_name: str) -> AgentCoreMemoryStore:
    return AgentCoreMemoryStore(memory_id=memory_id, region_name=region_name)


class _TurnCredentials(Credentials):
    """The newest Turn's credentials, which the signer reads for each request, for one Session sandbox."""

    def __init__(self, tags: dict[str, list[str]], issued: tuple[Credentials, datetime], turn: int) -> None:
        credentials, expiration = issued
        super().__init__(credentials.access_key, credentials.secret_key, credentials.token, method='turn-identity')
        self.sandbox = _sandbox(tags)
        self._turn = turn
        self._frozen = credentials.get_frozen_credentials()
        self._scope = tags, expiration

    def reuse(self, tags: dict[str, list[str]], turn: int) -> bool:
        """Whether these credentials carry the JWT's tags and outlive the reuse margin. When they do, the Turn
        joins the newest-Turn ordering, so an older Turn's exchange finishing later keeps them."""
        held, expiration = self._scope
        if held != tags or expiration - datetime.now(UTC) <= _REUSE_MARGIN:
            return False
        self._turn = max(self._turn, turn)
        return True

    def take(self, tags: dict[str, list[str]], issued: tuple[Credentials, datetime], turn: int) -> None:
        sandbox = _sandbox(tags)
        if sandbox != self.sandbox:
            raise MemorySandboxError(
                f'The Turn identity names Session {sandbox[1]} filed by {sandbox[0]}, '
                f'but this microVM serves Session {self.sandbox[1]} filed by {self.sandbox[0]}'
            )
        # An older Turn whose STS exchange finished last keeps the newer Turn's credentials (ADR 0067 §8).
        if turn < self._turn:
            return
        credentials, expiration = issued
        self._turn = turn
        # One assignment each, so a request signing or a Turn checking reuse meanwhile never mixes two exchanges.
        self._frozen = credentials.get_frozen_credentials()
        self._scope = tags, expiration
        self.access_key, self.secret_key, self.token = credentials.access_key, credentials.secret_key, credentials.token

    def get_frozen_credentials(self) -> ReadOnlyCredentials:
        return self._frozen


class _TurnCredentialProvider(CredentialProvider):
    METHOD = 'turn-identity'

    def __init__(self, credentials: _TurnCredentials) -> None:
        super().__init__()
        self._credentials = credentials

    def load(self) -> Credentials:
        return self._credentials


def _memory_client(credentials: _TurnCredentials, like: Any) -> Any:
    """A client configured as `like` that signs with whatever credentials the Turns last gave it."""
    session = botocore.session.Session()
    session.register_component('credential_provider', CredentialResolver([_TurnCredentialProvider(credentials)]))
    config = like.meta.config.merge(Config(max_pool_connections=_MEMORY_CONNECTIONS))
    return boto3.Session(botocore_session=session).client(
        'bedrock-agentcore', region_name=like.meta.region_name, config=config)


_MEMORY_LOCK = threading.Lock()
_MEMORY: tuple[_TurnCredentials, AgentCoreMemoryStore] | None = None
_TURNS = itertools.count()


def next_turn() -> int:
    """The Turn's place in arrival order. Take it on the event loop, before the Turn's STS exchange runs on a
    worker thread: exchanges, and the threads that run them, may finish in either order."""
    return next(_TURNS)


def turn_memory(
    memory_id: str, turn_identity: str, *, region_name: str, run_id: str, turn: int,
) -> tuple[WarmSessionSaver, AgentCoreMemoryStore]:
    """The Turn's checkpointer and store, on the microVM's Memory client, signing with credentials for the Turn's tags.

    A continuing Turn reuses the credentials held for its JWT's tags; any other Turn exchanges its JWT
    (ADR 0067 §8). A microVM serves one Session sandbox, which Account Claim keeps while the actor
    changes, so a Turn for another sandbox fails. The checkpointer keeps the Session warm in this
    process: a continuing Session's latest snapshot loads from Memory only when another process wrote it since.
    """
    global _MEMORY
    tags = _tags(turn_identity)
    # The check and the ordering are one step, or an older exchange could slip in between them.
    with _MEMORY_LOCK:
        held = _MEMORY if _MEMORY is not None and _MEMORY[0].reuse(tags, turn) else None
    if held is None:
        issued = _turn_credentials(turn_identity, region_name=region_name, run_id=run_id)
        with _MEMORY_LOCK:
            if _MEMORY is None:
                store = build_store(memory_id, region_name=region_name)
                signing = _TurnCredentials(tags, issued, turn)
                # The store's own client keeps its configuration but not its credentials, which are the runtime's.
                store.client = _memory_client(signing, store.client)
                _MEMORY = signing, store
            else:
                _MEMORY[0].take(tags, issued, turn)
            held = _MEMORY
    store = held[1]
    return WarmSessionSaver(memory_id, store.client, region_name=region_name), store


def _tags(turn_identity: str) -> dict[str, list[str]]:
    """The session tags the Turn's JWT carries, which STS checks on each exchange."""
    return _claims(turn_identity)[_TAGS_CLAIM]['principal_tags']


def _claims(turn_identity: str) -> dict[str, Any]:
    claims = turn_identity.split('.')[1]
    return json.loads(base64.urlsafe_b64decode(claims + '=' * (-len(claims) % 4)))


def finished_snapshot_epoch(turn_identity: str | None, marker: Any) -> str | None:
    """Bind registered writer proof to the JWT Chat issued for this invocation."""
    if not isinstance(marker, dict) or not turn_identity:
        return None
    epoch, turn_id = marker.get('epoch'), marker.get('turnId')
    if not isinstance(epoch, str) or not epoch or not isinstance(turn_id, str) or not turn_id:
        return None
    return epoch if _claims(turn_identity).get('jti') == turn_id else None


def _sandbox(tags: dict[str, list[str]]) -> tuple[str, str]:
    """The filing actor and Session the tags name."""
    return tags['filingActorId'][0], tags['sessionId'][0]


def _turn_credentials(turn_identity: str, *, region_name: str, run_id: str) -> tuple[Credentials, datetime]:
    if not USER_MEMORY_ROLE_ARN:
        raise RuntimeError('AgentCore Memory needs BOTCUBE_USER_MEMORY_ROLE_ARN, the role the Turn identity assumes')
    # AssumeRoleWithWebIdentity is an unsigned call: the JWT is the only credential it takes.
    sts = boto3.client('sts', region_name=region_name, config=Config(signature_version=UNSIGNED))
    try:
        credentials = sts.assume_role_with_web_identity(
            RoleArn=USER_MEMORY_ROLE_ARN,
            RoleSessionName=_role_session_name(run_id),
            WebIdentityToken=turn_identity,
        )['Credentials']
    except ClientError as error:
        details = error.response.get('Error', {})
        code = details.get('Code')
        if code in _REFUSED_IDENTITY:
            raise TurnIdentityError(f"STS refused the Turn identity: {code}: {details.get('Message', '')}") from error
        raise
    return (Credentials(credentials['AccessKeyId'], credentials['SecretAccessKey'], credentials['SessionToken']),
            credentials['Expiration'])


def _role_session_name(run_id: str) -> str:
    """The run ID as an STS role session name (2-64 of ``[\\w+=,.@-]``), which CloudTrail records."""
    return re.sub(r'[^\w+=,.@-]', '-', f'turn-{run_id}', flags=re.ASCII)[:64]


def opening(store: Any, actor_id: str) -> str:
    """The actor's opening Memory block, read on the Turn's store."""
    return opening_memory(store.client, memory_id=store.memory_id, actor_id=actor_id)


def build_memory_tools(*, actor_id: str, thread_id: str) -> tuple[list[Any], list[Any]]:
    """The `memory` tool and middleware, on the Turn's store, which the graph injects."""
    return [memory_tool(actor_id)], [
        TurnMemoryMiddleware(actor_id=actor_id, session_id=thread_id),
        SessionMemoryMiddleware(lambda store: opening(store, actor_id)),
    ]
