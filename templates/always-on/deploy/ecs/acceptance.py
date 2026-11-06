from __future__ import annotations

import http.cookiejar
import urllib.request
from collections.abc import Callable
from typing import Any

require: Callable[[object, str], None] = globals()['require']
request: Callable[..., tuple[int, Any]] = globals()['request']

MODEL = 'echo'


def conversation_owner_client() -> tuple[urllib.request.OpenerDirector, str]:
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    status, account = request(client, '/account/session')
    require(status == 200 and account['status'] == 'ready', 'Template session creation failed')
    return client, account['accountId']


def is_other_account(account: dict[str, Any], owner: str) -> bool:
    return account['status'] == 'ready' and account['accountId'] != owner


def filing_user_id(account_id: str) -> str:
    return account_id


def verify_sessions(table: Any) -> dict[str, bool]:
    clients = [conversation_owner_client() for _ in range(2)]
    require(clients[0][1] != clients[1][1], 'Template clients share an account')
    for client, owner in clients:
        status, account = request(client, '/account/session')
        require(status == 200 and account['accountId'] == owner, 'Template session did not resume')
    return {'created': True, 'resumed': True, 'isolated': True}


def conversation_prompt(expected: str, observation_seconds: float, progress_rounds: int) -> str:
    require(not observation_seconds, 'The echo model does not execute tools; configure a tool-capable acceptance model for replacement continuity')
    return expected


def verify_tool_result(call: dict[str, Any], event: dict[str, Any]) -> None:
    raise RuntimeError('The echo model does not execute tools')
