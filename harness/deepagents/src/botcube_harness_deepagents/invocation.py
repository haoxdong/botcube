from __future__ import annotations

from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ag_ui.core import RunAgentInput
from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
)

from . import message_times
from .agent_documents import AgentDocuments, AgentDocumentsError, parse_agent_documents
from .files import FilesBindingError, parse_files_mount
from .files_mount import FilesMount
from .llm import resolve_effort
from .memory.agentcore import (
    SnapshotEpoch,
    TurnIdentity,
    TurnIdentityError,
    require_turn_identity,
)


class InvalidInvocation(ValueError):
    pass


class AgentComputerBindingError(RuntimeError):
    code = 'INTERNAL_ERROR'


NonEmpty = Annotated[str, Field(min_length=1)]


class InvocationOptions(BaseModel):
    model_config = ConfigDict(strict=True, frozen=True, hide_input_in_errors=True)

    session_user_id: str | None = Field(None, alias='sessionUserId')
    warmup: bool = False
    preparation_scope: Literal['recorded', 'startup'] | None = Field(None, alias='preparationScope')
    steering: bool = False
    withdraw_steering: NonEmpty | None = Field(None, alias='withdrawSteering')
    stop: bool = False
    agent_system_prompt: str | None = Field(None, alias='agentSystemPrompt')
    bot_system_prompt: str | None = Field(None, alias='botSystemPrompt')
    bot_memory: bool = Field(True, alias='botMemory')
    opening: bool = False
    opening_first_name: str | None = Field(None, validation_alias=AliasChoices('opening_first_name', 'openingFirstName'))
    model: str | None = None
    effort: str | None = None
    scheduled_run: bool = Field(False, alias='scheduledRun')
    session_snapshot_epoch: SnapshotEpoch | None = Field(None, alias='sessionSnapshotEpoch')
    timezone: str | None = None
    started_at: int | None = Field(None, validation_alias=AliasChoices('turnStartedAt', 'turn_started_at'))
    worklog_clock: Annotated[int, Field(ge=0, le=1)] = Field(
        0, validation_alias=AliasChoices('worklog_clock', 'worklogClock'),
    )
    env: dict[str, str] | None = Field(None, repr=False)
    credential_service_url: str | None = Field(None, alias='credentialServiceUrl', repr=False)
    legacy_credential_token: str | None = Field(None, alias='credentialServiceInvocationToken', repr=False)
    user_token: str | None = Field(None, alias='userToken', repr=False)
    traffic: str | None = None

    @field_validator('model')
    @classmethod
    def default_model(cls, value: str | None) -> str | None:
        return value or None

    @field_validator('agent_system_prompt', 'preparation_scope', 'withdraw_steering')
    @classmethod
    def sent_value(cls, value: str | None) -> str:
        if value is None:
            raise ValueError('omit the field when no value is supplied')
        return value

    @field_validator('effort')
    @classmethod
    def known_effort(cls, value: str | None) -> str | None:
        if value is not None:
            resolve_effort(value)
        return value

    @field_validator('timezone')
    @classmethod
    def known_timezone(cls, value: str | None) -> str:
        if value is None:
            raise ValueError('must be an IANA timezone string')
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as error:
            raise ValueError('must be an IANA timezone string') from error
        return value

    @field_validator('session_snapshot_epoch', mode='before')
    @classmethod
    def snapshot_proof(cls, value: object) -> SnapshotEpoch | None:
        if not isinstance(value, dict):
            return None
        epoch, turn_id = value.get('epoch'), value.get('turnId')
        # A legacy or unusable marker grants no snapshot reuse. The Turn reads its Transcript from Memory.
        if not isinstance(epoch, str) or not epoch or not isinstance(turn_id, str) or not turn_id:
            return None
        return SnapshotEpoch(epoch=epoch, turn_id=turn_id)

    @field_validator('started_at', mode='before')
    @classmethod
    def start_time(cls, value: object) -> int | None:
        try:
            return message_times.turn_start(value)
        except TypeError as error:
            raise ValueError(str(error)) from error

class InvalidBinding(RuntimeError):
    def __init__(
        self, error: AgentDocumentsError | FilesBindingError | AgentComputerBindingError | TurnIdentityError,
        options: InvocationOptions,
    ) -> None:
        super().__init__(str(error))
        self.code = error.code
        self.options = options


def _browser_url(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise AgentComputerBindingError('agentComputerCdpUrl must be a non-empty URL')
    return value


_SDK_PRIVATE_PROPS = {
    'agentIdentity', 'soul', 'files', 'sessionUserId', 'userToken', 'agentComputerCdpUrl',
    'turnIdentity', 'credentialServiceInvocationToken',
}


class Invocation(RunAgentInput):
    options: InvocationOptions = Field(default_factory=InvocationOptions, exclude=True, repr=False)
    agent_computer_cdp_url: str | None = Field(None, exclude=True, repr=False)
    turn_identity: TurnIdentity | None = Field(None, exclude=True, repr=False)
    documents: AgentDocuments | None = Field(None, exclude=True, repr=False)
    files: FilesMount | None = Field(None, exclude=True, repr=False)
    redaction_environment: dict[str, str] = Field(default_factory=dict, exclude=True, repr=False)

    @classmethod
    def parse(cls, run: RunAgentInput) -> Invocation:
        props = run.forwarded_props
        if props is None:
            props = {}
        if not isinstance(props, dict) or any(not isinstance(key, str) for key in props):
            raise InvalidInvocation('forwardedProps must be an object')
        try:
            options = InvocationOptions.model_validate(props)
        except ValidationError as error:
            fields = ', '.join('.'.join(map(str, item['loc'])) for item in error.errors(include_input=False))
            raise InvalidInvocation(f'Invalid forwardedProps.{fields}') from None
        try:
            documents = parse_agent_documents(props.get('agentIdentity'), props.get('soul'))
            files = parse_files_mount(props.get('files'))
            cdp_url = _browser_url(props.get('agentComputerCdpUrl'))
            raw_identity = props.get('turnIdentity')
            turn_identity = require_turn_identity(raw_identity) if raw_identity is not None else None
        except (AgentDocumentsError, FilesBindingError, AgentComputerBindingError, TurnIdentityError) as error:
            raise InvalidBinding(error, options) from error
        return cls.model_validate({
            **dict(run),
            'forwarded_props': {key: value for key, value in props.items() if key not in _SDK_PRIVATE_PROPS},
            'options': options,
            'agent_computer_cdp_url': cdp_url,
            'turn_identity': turn_identity,
            'documents': documents,
            'files': files,
            'redaction_environment': {
                **{key: value for key, value in props.items() if isinstance(value, str) and key != 'credentialServiceInvocationToken'},
                **(options.env or {}),
            },
        })
