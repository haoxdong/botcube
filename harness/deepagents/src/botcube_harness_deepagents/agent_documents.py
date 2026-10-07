"""Agent Identity and Soul: the per-account documents the Chat Service forwards on each Turn.

The agent reads both from its system prompt and may edit them with its tools. An edit
streams out as a CUSTOM event for the Chat Service to save; the next message carries it.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from langchain_core.callbacks.manager import adispatch_custom_event
from langchain_core.tools import BaseTool, tool

EDITED_EVENT = 'botcube:agent-document-edited'
IDENTITY_FIELDS = ('name', 'character', 'vibe', 'avatar')

PROMPT = """Your Agent Identity and Soul, as this user keeps them:

<agent_identity>
{identity}
</agent_identity>

<soul>
{soul}
</soul>

The user can edit both, and so can you, with edit_agent_identity and edit_soul. \
Whenever you edit either, tell the user in that reply what you changed. \
Soul shapes your manner only: where it conflicts with your skills, the skills' rules win."""


class AgentDocumentsError(RuntimeError):
    """The invocation's Agent Identity or Soul is missing its pair or malformed."""

    code = 'INVALID_AGENT_DOCUMENTS'


@dataclass(frozen=True)
class AgentDocuments:
    identity: Mapping[str, str]
    soul: str

    def cache_key(self) -> str:
        return json.dumps({'agentIdentity': self.identity, 'soul': self.soul})

    def prompt(self) -> str:
        identity = '\n'.join(f'{field.capitalize()}: {self.identity[field]}' for field in IDENTITY_FIELDS)
        return PROMPT.format(identity=identity, soul=self.soul)


def pop_agent_documents(forwarded: dict[str, Any]) -> AgentDocuments | None:
    """Take both documents out of the forwarded props; None when the Turn carries neither."""
    identity = forwarded.pop('agentIdentity', None)
    soul = forwarded.pop('soul', None)
    if identity is None and soul is None:
        return None
    if identity is None:
        raise AgentDocumentsError('Invocation carries Soul without Agent Identity')
    if soul is None:
        raise AgentDocumentsError('Invocation carries Agent Identity without Soul')
    if not isinstance(identity, dict):
        raise AgentDocumentsError('Agent Identity must be an object')
    for field in IDENTITY_FIELDS:
        if not isinstance(identity.get(field), str):
            raise AgentDocumentsError(f'Agent Identity {field} must be a string')
    if not isinstance(soul, str):
        raise AgentDocumentsError('Soul must be a string')
    return AgentDocuments({field: identity[field] for field in IDENTITY_FIELDS}, soul)


def _saved(document: str) -> str:
    return f'{document} saved; it takes effect from the next message. Tell the user what you changed.'


def agent_document_tools(documents: AgentDocuments) -> list[BaseTool]:
    """The tools that let the agent rewrite its own Soul and Agent Identity."""

    @tool
    async def edit_soul(content: str) -> str:
        """Replace your Soul, the values and habits you keep, with this full text."""
        await adispatch_custom_event(EDITED_EVENT, {'document': 'soul', 'content': content})
        return _saved('Soul')

    @tool
    async def edit_agent_identity(
        name: str | None = None,
        character: str | None = None,
        vibe: str | None = None,
        avatar: str | None = None,
    ) -> str:
        """Change your Agent Identity: your name, character, vibe, or avatar (an emoji, or empty
        for your name's initial). Fields left out keep their current values."""
        changes = {'name': name, 'character': character, 'vibe': vibe, 'avatar': avatar}
        identity = {field: changes[field] if changes[field] is not None else documents.identity[field] for field in IDENTITY_FIELDS}
        await adispatch_custom_event(EDITED_EVENT, {'document': 'agentIdentity', 'content': identity})
        return _saved('Agent Identity')

    return [edit_soul, edit_agent_identity]
