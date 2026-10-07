# Import side effect: load .env (or fetch the LangSmith key from SSM) before
# any model or agent import so LangSmith tracing is active for every call.
from . import _env as _env
from .agent import AgentResponseError, ask, build_agent
from .llm import (
    AVAILABLE_MODELS,
    DEFAULT_MAX_TOKENS,
    DEFAULT_MODEL,
    EFFORT_LEVELS,
    build_bedrock_model,
    build_model,
)

__all__ = [
    'AVAILABLE_MODELS',
    'DEFAULT_MODEL',
    'DEFAULT_MAX_TOKENS',
    'EFFORT_LEVELS',
    'AgentResponseError',
    'ask',
    'build_agent',
    'build_bedrock_model',
    'build_model',
]
