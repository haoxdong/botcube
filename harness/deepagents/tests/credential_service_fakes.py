"""The Credential Service's stand-in mTLS front and certificates, which the Harness's twin `endpoint_tls` shares."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType


def _mtls_fake() -> ModuleType:
    path = Path(__file__).resolve().parents[3] / 'credential-service/tests/mtls_fake.py'
    spec = importlib.util.spec_from_file_location('mtls_fake', path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules['mtls_fake'] = module
    spec.loader.exec_module(module)
    return module


mtls_fake = _mtls_fake()
