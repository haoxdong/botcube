from __future__ import annotations

import asyncio
import base64
import json
import time

from botcube_cartridge import ModelRelay


def invocation_deadline(relay: ModelRelay | None) -> float | None:
    if relay is None or not relay.token.startswith('v1.'):
        return None
    _, payload, _ = relay.token.split('.')
    claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
    expires_at = claims['expires_at']
    if not isinstance(expires_at, int):
        raise ValueError('Credential Service invocation expiry must be an integer')
    return asyncio.get_running_loop().time() + expires_at - time.time() - 60


async def wait_for_turn(work: asyncio.Task[None], deadline: float | None) -> bool:
    remaining = None if deadline is None else deadline - asyncio.get_running_loop().time()
    if remaining is not None and remaining <= 0:
        work.cancel()
        await asyncio.wait([work])
        return True
    done, _ = await asyncio.wait([work], timeout=remaining)
    if done:
        return False
    work.cancel()
    await asyncio.wait([work])
    return True
