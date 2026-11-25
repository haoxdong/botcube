from __future__ import annotations

from pathlib import Path
from typing import cast

import pytest
from fastapi.testclient import TestClient

from botcube_credential_service.stock import stock_credential_service
from botcube_credential_service.vault import RotatingCredentialVault

STOCK_DOCKERFILE = Path(__file__).resolve().parents[1] / 'Dockerfile'


def test_the_stock_service_answers_health_as_stock_with_openai_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('BOTCUBE_MODELS_ENDPOINT', raising=False)
    # A configured vault: health asks for no more than that it resolves.
    app = stock_credential_service(lambda: cast(RotatingCredentialVault, object()), lambda: 'secret')

    response = TestClient(app).get('/health')

    assert response.status_code == 200
    assert response.json() == {'status': 'ok', 'service': 'stock'}


def test_the_stock_service_is_unhealthy_while_its_vault_is_unconfigured() -> None:
    def unconfigured() -> RotatingCredentialVault:
        raise ValueError('Vault table and KMS key are required')

    response = TestClient(stock_credential_service(unconfigured, lambda: 'secret')).get('/health')

    assert response.status_code == 503
    assert response.json()['detail']['component'] == 'vault'


def test_the_stock_image_runs_the_stock_service_from_its_packages() -> None:
    dockerfile = STOCK_DOCKERFILE.read_text()
    copies = [line.split()[1] for line in dockerfile.splitlines() if line.startswith('COPY ') and '--from=' not in line]
    assert copies == [
        '${BOTCUBE_ROOT}/credential-source/',
        '${BOTCUBE_ROOT}/credential-service/',
    ]
    assert dockerfile.rstrip().endswith('CMD ["python", "-m", "botcube_credential_service.stock"]')
