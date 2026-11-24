"""The prompts a Session's agent is built with: the system prompt, the bot's instructions and the User's own."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from .agent_documents import AgentDocuments
from .files import excluded_paths, files_prompt


@dataclass(frozen=True)
class AgentPrompts:
    system: str
    # The bot's instructions, which also lead the general-purpose subagent; empty, none.
    bot: str
    user: str


def agent_prompts(
    *,
    agent_system_prompt: str,
    bot_instructions: str,
    candidate_bot_instructions: str | None,
    profile: str,
    root: Path,
    skills: Sequence[str],
    syncs_files: bool,
    documents: AgentDocuments | None,
) -> AgentPrompts:
    """The agent's prompts, with a candidate's bot instructions in place of the bot's own when it gives some."""
    bot = bot_instructions if candidate_bot_instructions is None else candidate_bot_instructions
    return AgentPrompts(
        system='\n\n'.join(part for part in (agent_system_prompt, bot) if part),
        bot=bot,
        user=_user_prompt(profile, root, skills if syncs_files else None, documents),
    )


def _user_prompt(profile: str, root: Path, synced_skills: Sequence[str] | None, documents: AgentDocuments | None) -> str:
    return '\n\n'.join(
        part
        for part in (
            profile and f'<user_profile>\n{profile}\n</user_profile>',
            synced_skills is not None and f'<files>\n{files_prompt(root, excluded_paths(synced_skills))}\n</files>',
            documents.prompt() if documents else '',
        )
        if part
    )
