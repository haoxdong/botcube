"""The Agent Computer a Turn drives: agent-browser's connection to the browser the Chat Service forwards."""

import hashlib
import json
from dataclasses import replace

from .definition import InvocationAuth


def with_agent_computer(auth: InvocationAuth, cdp_url: str | None, session: tuple[str, str]) -> InvocationAuth:
    if cdp_url is None:
        return auth
    return replace(auth, environment={
        **(auth.environment or {}),
        'AGENT_BROWSER_CDP': cdp_url,
        'AGENT_BROWSER_SESSION': hashlib.sha256(json.dumps(session).encode()).hexdigest()[:32],
        # agent-browser's daemon outlives its browser; idle expiry follows the Turn token.
        'AGENT_BROWSER_IDLE_TIMEOUT_MS': str(60 * 60 * 1000),
    })
