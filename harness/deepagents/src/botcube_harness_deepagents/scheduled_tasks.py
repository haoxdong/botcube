"""The agent's half of a scheduled task: it proposes, and the user confirms in the chat.

The proposal is only this tool call. The UI shows it with a confirm button, and
confirming creates the task in the Chat Service; the agent never schedules
anything itself. A proposal carries the schedule as the Edit form's fields, so
the card and the form show the same values.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator


class ScheduledTaskProposal(BaseModel):
    """A task and when it runs, in an explicit time zone: recurring, or once."""

    model_config = ConfigDict(extra='forbid')

    title: str = Field(description='A short name for the task, such as "Morning rates brief".')
    prompt: str = Field(description="What to do on each run, written as the user's request, without when or how often it runs.")
    timezone: str = Field(description='The requested IANA time zone, such as UTC, America/New_York or Asia/Tokyo. All date, time, starts and ends fields use this zone.')
    frequency: Literal['minutes', 'hours', 'daily', 'weekdays', 'weekly', 'once'] = Field(
        description='Every N minutes or hours, daily, on weekdays (Monday to Friday), weekly on chosen days, or once on a date.'
    )
    every: Annotated[int, Field(ge=1)] | None = Field(None, validate_default=True, description='N, for minutes and hours only.')
    time: Annotated[str, Field(pattern=r'^([01]\d|2[0-3]):[0-5]\d$')] | None = Field(
        None, validate_default=True, description='The time of day as HH:MM on a 24-hour clock, for daily, weekdays, weekly and once only.'
    )
    date: Annotated[str, Field(pattern=r'^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$')] | None = Field(
        None, validate_default=True, description='The day a once task runs, as YYYY-MM-DD, for once only.'
    )
    days: list[Literal['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']] | None = Field(
        None, min_length=1, validate_default=True, description='The days a weekly task runs, such as ["MON", "THU"].'
    )
    ends: Annotated[str, Field(pattern=r'^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d$')] | None = Field(
        None, description='When a recurring task stops running, as YYYY-MM-DDTHH:MM; leave it out to run until deleted. Not for once.'
    )
    starts: Annotated[str, Field(pattern=r'^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d$')] | None = Field(
        None, description='When a recurring task starts, as YYYY-MM-DDTHH:MM in timezone. Not for once.'
    )

    @field_validator('timezone')
    @classmethod
    def _known_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as failure:
            raise ValueError('must be a valid IANA time zone') from failure
        return value

    @field_validator('every', 'time', 'date', 'days')
    @classmethod
    def _matches_frequency(cls, value: object, info: ValidationInfo) -> object:
        # Each field's own error, so the agent is told which field to fix.
        frequency = info.data.get('frequency')
        wanted = {'every': ('minutes', 'hours'), 'time': ('daily', 'weekdays', 'weekly', 'once'), 'date': ('once',), 'days': ('weekly',)}
        needed = frequency in wanted[str(info.field_name)]
        if frequency is not None and needed != (value is not None):
            raise ValueError(f'{"required" if needed else "not allowed"} for {frequency}')
        return value

    @field_validator('ends', 'starts')
    @classmethod
    def _recurring_only(cls, value: object, info: ValidationInfo) -> object:
        # A once task runs once: it has nothing to stop.
        if value is not None and info.data.get('frequency') == 'once':
            raise ValueError('not allowed for once')
        if isinstance(value, str):
            datetime.fromisoformat(value)
            ends = info.data.get('ends')
            if info.field_name == 'starts' and isinstance(ends, str) and value >= ends:
                raise ValueError('ends must be after starts')
        return value


@tool(args_schema=ScheduledTaskProposal)
def propose_scheduled_task(config: RunnableConfig, **fields: object) -> str:
    """Propose a task when the user asks for work on a schedule, or once at a later time.

    Use starts and ends for time-bounded recurring work. Choose actual wall datetimes, never a run count.
    Preserve the user's requested time zone in timezone and interpret every date and time in that zone.
    If no zone was requested and the user's local zone is unknown, ask for it before proposing. Never guess.
    Describe the exact accepted schedule returned by this tool, including its time zone and bounds.

    Nothing is scheduled until the user confirms the proposal in the chat. Every
    run adds a Turn to the task's one Side Chat, with earlier runs available to
    the agent. Its result is posted to the user's Main Chat.
    """
    model = config.get('configurable', {}).get('scheduled_task_model')
    if not isinstance(model, str) or not model:
        raise ValueError('The proposing Turn has no model key')
    return json.dumps({
        'model': model,
        'proposal': {key: value for key, value in fields.items() if value is not None},
        'message': 'Proposed. Nothing is scheduled until the user confirms it in the chat.',
    })
