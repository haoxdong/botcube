"""The Chat Service counts no request whose user agent carries the marker as a person's
(botcube/chat/src/production-activity.ts), so a deploy check never keeps a parked deployment awake."""

import os

MARKER = '-Verification/'
BOTCUBE = {
    'VERIFICATION_USER_AGENT': 'BotCube-Preview-Verification/1.0',
    'ORIGIN_VERIFICATION_USER_AGENT': 'BotCube-Origin-Verification/1.0',
}


def user_agent(name: str = 'VERIFICATION_USER_AGENT') -> str:
    """The user agent the environment variable `name` gives, which must carry the deploy-check marker; unset, BotCube's."""
    value = os.environ.get(name) or BOTCUBE[name]
    if MARKER not in value:
        raise RuntimeError(f'{name} must give the deploy check user agent, carrying {MARKER}')
    return value
