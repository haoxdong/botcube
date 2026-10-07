import os as _os
from pathlib import Path as _Path

from dotenv import load_dotenv as _load_dotenv

_load_dotenv(
    _Path(_os.environ['BOTCUBE_ENV_FILE'])
    if 'BOTCUBE_ENV_FILE' in _os.environ
    else _Path(__file__).resolve().parents[5] / '.env',
    override=False,
)
_os.environ['LANGSMITH_TRACING'] = 'false'
_os.environ['LANGCHAIN_TRACING_V2'] = 'false'


def positive_int(name: str, default: int) -> int:
    value = int(_os.environ.get(name, str(default)))
    if value <= 0:
        raise ValueError(f'{name} must be a positive integer')
    return value


def positive_float(name: str, default: float) -> float:
    value = float(_os.environ.get(name, str(default)))
    if not 0 < value < float('inf'):
        raise ValueError(f'{name} must be finite and positive')
    return value
