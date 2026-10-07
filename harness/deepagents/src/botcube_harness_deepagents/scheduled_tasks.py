"""The agent's half of a scheduled task: it proposes, and the user confirms in the chat.

The proposal is only this tool call. The UI shows it with a confirm button, and
confirming creates the task in the Chat Service; the agent never schedules
anything itself.
"""

from __future__ import annotations

from langchain_core.tools import tool


@tool
def propose_scheduled_task(title: str, prompt: str, schedule: str) -> str:
    """Propose a recurring task when the user asks for work on a schedule.

    Nothing is scheduled until the user confirms the proposal in the chat. Each
    run happens in a fresh chat and its result is posted to the user's Main Chat.

    Args:
        title: A short name for the task, such as "Morning rates brief".
        prompt: What to do on each run, written as the user's request.
        schedule: An EventBridge Scheduler expression in the user's local time,
            such as ``cron(0 8 ? * MON-FRI *)`` or ``rate(1 day)``.
    """
    return 'Proposed. Nothing is scheduled until the user confirms it in the chat.'
