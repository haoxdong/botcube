"""The telemetry Endpoint's credential on the Harness's OTLP exporter.

OpenTelemetry Python loads this as the `botcube` `opentelemetry_otlp_credential_provider` entry point when
OTEL_PYTHON_EXPORTER_OTLP_HTTP_TRACES_CREDENTIAL_PROVIDER names it; the deploy sets that beside the Credential Source,
as botcube/deployment-config's `telemetry.ts` projects the Deployment Config's `telemetry` section.
"""
from __future__ import annotations

import requests
from requests.auth import AuthBase

from .credential_source import CredentialSource, credential_source_from_env

TELEMETRY_CREDENTIAL_ENV = 'BOTCUBE_TELEMETRY_CREDENTIAL'


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
        raise RuntimeError(f'{TELEMETRY_CREDENTIAL_ENV} is unset; the deploy sets it with the botcube OTLP credential provider')
    session = requests.Session()
    session.auth = _Bearer(source)
    return session


def telemetry_credential() -> CredentialSource | None:
    return credential_source_from_env('telemetry.credential', TELEMETRY_CREDENTIAL_ENV)
