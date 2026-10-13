"""AgentCore Memory under each Turn's own credentials (ADR 0067 §8).

The Chat Service signs a per-Turn JWT tagged with the Turn's actor, the Session's filing
actor and the Session. STS ``AssumeRoleWithWebIdentity`` turns it into credentials of the
Memory role, whose policy reads those tags, and one ``bedrock-agentcore`` client built from
them serves the Turn's checkpointer, store, ``memory`` tool, Pending Memory and turn feed.
The Agent Service's own role holds no Memory permission.
"""

from __future__ import annotations

import os
import re
from typing import Any, TypedDict, Unpack

import boto3
import botocore.session
from botocore import UNSIGNED
from botocore.config import Config
from botocore.exceptions import ClientError
from langgraph_checkpoint_aws import AgentCoreMemorySaver, AgentCoreMemoryStore

from ...memory_document import opening_memory
from ...memory_tools import memory_tool
from ...session_memory import SessionMemoryMiddleware
from ...turn_memory import TurnMemoryMiddleware
from .warm_session import WarmSessionSaver

__all__ = [
    'TurnIdentityError', 'build_checkpointer', 'build_memory_tools', 'build_store', 'is_access_denied', 'turn_memory',
]

USER_MEMORY_ROLE_ARN = os.getenv('BOTCUBE_USER_MEMORY_ROLE_ARN', '')
# What STS answers a JWT it refuses: a bad signature, issuer or audience, an expired token, or a refused claim.
_REFUSED_IDENTITY = frozenset({'InvalidIdentityToken', 'ExpiredTokenException', 'IDPRejectedClaim'})
_MEMORY_OPERATIONS = frozenset(botocore.session.get_session().get_service_model('bedrock-agentcore').operation_names)


class TurnIdentityError(RuntimeError):
    """The invocation's per-Turn JWT is missing, or STS refused it."""

    code = 'TURN_IDENTITY_REJECTED'


def is_access_denied(error: BaseException) -> bool:
    """Whether AgentCore Memory refused a call outside the Turn credentials' tagged scope."""
    return (
        isinstance(error, ClientError)
        and error.response.get('Error', {}).get('Code') == 'AccessDeniedException'
        and error.operation_name in _MEMORY_OPERATIONS
    )


class _Credentials(TypedDict, total=False):
    aws_access_key_id: str
    aws_secret_access_key: str
    aws_session_token: str


def build_checkpointer(memory_id: str, *, region_name: str, **credentials: Unpack[_Credentials]) -> AgentCoreMemorySaver:
    """The stock saver in snapshot format, as shipped (ADR 0067 decision 9)."""
    return AgentCoreMemorySaver(memory_id, checkpoint_format='snapshot', limit=None, region_name=region_name, **credentials)


def build_store(memory_id: str, *, region_name: str, **credentials: Unpack[_Credentials]) -> AgentCoreMemoryStore:
    return AgentCoreMemoryStore(memory_id=memory_id, region_name=region_name, **credentials)


def turn_memory(
    memory_id: str, turn_identity: str, *, region_name: str, run_id: str,
) -> tuple[WarmSessionSaver, AgentCoreMemoryStore]:
    """The Turn's checkpointer and store, on one client with the Turn's tagged credentials.

    The checkpointer keeps the Session warm in this process: a continuing Session's latest snapshot loads
    from Memory only when another process wrote it since.
    """
    credentials = _turn_credentials(turn_identity, region_name=region_name, run_id=run_id)
    store = build_store(memory_id, region_name=region_name, **credentials)
    return WarmSessionSaver(memory_id, store.client, region_name=region_name), store


def _turn_credentials(turn_identity: str, *, region_name: str, run_id: str) -> _Credentials:
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
    return {
        'aws_access_key_id': credentials['AccessKeyId'],
        'aws_secret_access_key': credentials['SecretAccessKey'],
        'aws_session_token': credentials['SessionToken'],
    }


def _role_session_name(run_id: str) -> str:
    """The run ID as an STS role session name (2-64 of ``[\\w+=,.@-]``), which CloudTrail records."""
    return re.sub(r'[^\w+=,.@-]', '-', f'turn-{run_id}', flags=re.ASCII)[:64]


def build_memory_tools(*, actor_id: str, thread_id: str) -> tuple[list[Any], list[Any]]:
    """The `memory` tool and middleware, on the Turn's store, which the graph injects."""
    return [memory_tool(actor_id)], [
        TurnMemoryMiddleware(actor_id=actor_id, session_id=thread_id),
        SessionMemoryMiddleware(lambda store: opening_memory(store.client, memory_id=store.memory_id, actor_id=actor_id)),
    ]
