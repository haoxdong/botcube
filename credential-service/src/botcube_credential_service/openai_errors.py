from typing import Any

from .provider import UpstreamRefusal

# The `type` of a classified Plan Usage error, in OpenAI's error shape so the Harness's client raises it.
PLAN_USAGE_ERROR_TYPE = 'plan_usage'
REVOKED = (
    'PLAN_USAGE_REVOKED',
    'Your ChatGPT plan cannot be used: it is not eligible, or its credential was revoked or can no longer refresh. '
    'Re-run the botcube-openai-plan-usage operator command to sign in to ChatGPT again',
)
UNAVAILABLE = ('PLAN_USAGE_UNAVAILABLE', "ChatGPT could not check your plan's usage; try again later")


def plan_usage_error(classification: tuple[str, str], cause: str) -> dict[str, Any]:
    code, message = classification
    return {'error': {'type': PLAN_USAGE_ERROR_TYPE, 'code': code, 'message': f'{message} ({cause}).'}}


def revoked(cause: str) -> UpstreamRefusal:
    return UpstreamRefusal(401, plan_usage_error(REVOKED, cause))


def unavailable(cause: str) -> UpstreamRefusal:
    return UpstreamRefusal(503, plan_usage_error(UNAVAILABLE, cause))
