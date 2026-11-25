from __future__ import annotations

import pytest
from botcube_credential_source import (
    CredentialSourceError,
    credential_source,
)


def test_refuses_at_startup_a_token_only_the_chat_service_signs() -> None:
    with pytest.raises(
        CredentialSourceError,
        match=r'^telemetry\.credential credential \(botcube collector\): only the Chat Service signs a botcube token, with its Turn identity keys$',
    ):
        credential_source('telemetry.credential', {'kind': 'botcube', 'audience': 'collector'})
