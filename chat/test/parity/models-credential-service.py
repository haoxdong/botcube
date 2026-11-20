from __future__ import annotations

import os

import uvicorn

from botcube_credential_service.audit import (
    CredentialAuditRecorder,
    StdoutCredentialAuditSink,
)
from botcube_credential_service.models import models_provider_from_env
from botcube_credential_service.server import CredentialServiceSettings, create_app

models = models_provider_from_env(CredentialAuditRecorder(sink=StdoutCredentialAuditSink()))
if models is None:
    raise SystemExit('BOTCUBE_MODELS_ENDPOINT is unset: the local stack starts this service only for a models Endpoint')
app = create_app(CredentialServiceSettings('local', lambda: os.environ['BOTCUBE_CREDENTIAL_INVOCATION_SECRET']), [models])
uvicorn.run(app, host='127.0.0.1', port=int(os.environ['PORT']))
