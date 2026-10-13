"""AgentCore Memory under each Turn's own credentials (ADR 0067 §8).

The Chat Service signs a per-Turn JWT tagged with the Turn's actor, the Session's filing
actor and the Session. STS ``AssumeRoleWithWebIdentity`` turns it into credentials of the
Memory role, whose policy reads those tags. The microVM's one ``bedrock-agentcore`` client
signs with the newest Turn's credentials and serves its checkpointer, store, ``memory`` tool,
Pending Memory and turn feed, so Turns reuse its open connections. The Agent Service's own
role holds no Memory permission.
"""

from __future__ import annotations

import base64
import itertools
import json
import os
import re
import threading
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
    'MemorySandboxError', 'TurnIdentityError', 'build_checkpointer', 'build_memory_tools', 'build_store', 'is_access_denied', 'opening',
    'next_turn',
    'turn_memory',
]

USER_MEMORY_ROLE_ARN = os.getenv('BOTCUBE_USER_MEMORY_ROLE_ARN', '')
# What STS answers a JWT it refuses: a bad signature, issuer or audience, an expired token, or a refused claim.
_REFUSED_IDENTITY = frozenset({'InvalidIdentityToken', 'ExpiredTokenException', 'IDPRejectedClaim'})
_MEMORY_OPERATIONS = frozenset(botocore.session.get_session().get_service_model('bedrock-agentcore').operation_names)
_TAGS_CLAIM = 'https://aws.amazon.com/tags'
# Live, a Turn's opening Memory read, history read and turn feed overlapped 12 calls.
_MEMORY_CONNECTIONS = 16


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

    def __init__(self, sandbox: tuple[str, str], credentials: Credentials, turn: int) -> None:
        super().__init__(credentials.access_key, credentials.secret_key, credentials.token, method='turn-identity')
        self.sandbox = sandbox
        self._turn = turn
        self._frozen = credentials.get_frozen_credentials()

    def take(self, sandbox: tuple[str, str], credentials: Credentials, turn: int) -> None:
        if sandbox != self.sandbox:
            raise MemorySandboxError(
                f'The Turn identity names Session {sandbox[1]} filed by {sandbox[0]}, '
                f'but this microVM serves Session {self.sandbox[1]} filed by {self.sandbox[0]}'
            )
        # An older Turn whose STS exchange finished last keeps the newer Turn's credentials (ADR 0067 §8).
        if turn < self._turn:
            return
        self._turn = turn
        # One assignment, so a request signing meanwhile never mixes two Turns' keys.
        self._frozen = credentials.get_frozen_credentials()
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
    """The Turn's checkpointer and store, on the microVM's Memory client, now signing with the Turn's credentials.

    A microVM serves one Session sandbox, which Account Claim keeps while the actor changes, so a Turn
    for another sandbox fails. The checkpointer keeps the Session warm in this process: a continuing
    Session's latest snapshot loads from Memory only when another process wrote it since.
    """
    global _MEMORY
    credentials = _turn_credentials(turn_identity, region_name=region_name, run_id=run_id)
    sandbox = _sandbox(turn_identity)
    with _MEMORY_LOCK:
        if _MEMORY is None:
            store = build_store(memory_id, region_name=region_name)
            signing = _TurnCredentials(sandbox, credentials, turn)
            # The store's own client keeps its configuration but not its credentials, which are the runtime's.
            store.client = _memory_client(signing, store.client)
            _MEMORY = signing, store
        else:
            _MEMORY[0].take(sandbox, credentials, turn)
        store = _MEMORY[1]
    return WarmSessionSaver(memory_id, store.client, region_name=region_name), store


def _sandbox(turn_identity: str) -> tuple[str, str]:
    """The filing actor and Session the Turn's JWT tags; STS has already checked its signature."""
    claims = turn_identity.split('.')[1]
    tags = json.loads(base64.urlsafe_b64decode(claims + '=' * (-len(claims) % 4)))[_TAGS_CLAIM]['principal_tags']
    return tags['filingActorId'][0], tags['sessionId'][0]


def _turn_credentials(turn_identity: str, *, region_name: str, run_id: str) -> Credentials:
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
    return Credentials(credentials['AccessKeyId'], credentials['SecretAccessKey'], credentials['SessionToken'])


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
