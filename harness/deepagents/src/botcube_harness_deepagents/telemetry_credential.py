"""The telemetry Endpoint's credential on the Harness's OTLP exporter.

OpenTelemetry Python loads this as the `botcube` `opentelemetry_otlp_credential_provider` entry point when
OTEL_PYTHON_EXPORTER_OTLP_HTTP_TRACES_CREDENTIAL_PROVIDER names it, as botcube/deployment-config's `telemetry.ts` sets it
beside the Deployment Config's `otlp` Endpoint; the Credential Source is read from the file.
"""
from __future__ import annotations

import requests
from requests.auth import AuthBase

from .credential_source import CredentialSource, credential_source
from .deployment_config import deployment_config_from_env


class _Bearer(AuthBase):
    """Sends the source's current value as the bearer, read again before it expires."""

    def __init__(self, source: CredentialSource) -> None:
        self._source = source

    def __call__(self, r: requests.PreparedRequest) -> requests.PreparedRequest:
        r.headers['Authorization'] = f'Bearer {self._source.get().value}'
        return r


def telemetry_session() -> requests.Session:
    """A session that authenticates each export with the telemetry credential the deploy set."""
    source = telemetry_credential()
    if source is None:
        raise RuntimeError('The Deployment Config names no telemetry.credential; the deploy sets the botcube OTLP credential provider only beside one')
    session = requests.Session()
    session.auth = _Bearer(source)
    return session


def telemetry_credential() -> CredentialSource | None:
    """The Deployment Config's `otlp` Endpoint credential, or None."""
    telemetry = deployment_config_from_env()['telemetry']
    return credential_source('telemetry.credential', telemetry['credential']) if 'credential' in telemetry else None
