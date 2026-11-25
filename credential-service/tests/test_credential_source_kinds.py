from __future__ import annotations

import json
from pathlib import Path

import pytest
from botcube_credential_source import (
    CredentialSourceError,
    credential_source,
)

SCHEMA = Path(__file__).resolve().parents[2] / 'config' / 'botcube.schema.json'


def _models_credential_kinds() -> list[str]:
    schema = json.loads(SCHEMA.read_text())
    [endpoint] = [each for each in schema['properties']['integrations']['properties']['modelGateway']['oneOf'] if 'credential' in each['properties']]
    definition = endpoint['properties']['credential']['$ref'].removeprefix('#/$defs/')
    return [each['properties']['kind']['const'] for each in schema['$defs'][definition]['oneOf']]


@pytest.mark.parametrize('kind', _models_credential_kinds())
def test_every_credential_kind_the_botcube_config_accepts_is_one_the_relay_knows(kind: str) -> None:
    with pytest.raises(CredentialSourceError) as refused:
        credential_source('models', {'kind': kind})

    assert not str(refused.value).startswith('models credential: kind:')
