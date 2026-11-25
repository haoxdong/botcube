from __future__ import annotations

import os

import uvicorn

from botcube_credential_service.audit import (
    CredentialAuditRecorder,
    StdoutCredentialAuditSink,
)
from botcube_credential_service.models import models_provider_from_config
from botcube_credential_service.resolved_config import resolved_config_from_env
from botcube_credential_service.server import CredentialServiceSettings, create_app

resolved = resolved_config_from_env()
models = models_provider_from_config(CredentialAuditRecorder(sink=StdoutCredentialAuditSink()), resolved)
if models is None:
    raise SystemExit('The BotCube Config runs on Bedrock: the local stack starts this service only for a models Endpoint')
app = create_app(
    CredentialServiceSettings('local', lambda: os.environ['BOTCUBE_CREDENTIAL_INVOCATION_SECRET']), [models], config=resolved['config'],
)
uvicorn.run(app, host='127.0.0.1', port=int(os.environ['PORT']))
