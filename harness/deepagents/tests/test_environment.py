import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

# Runs a real subprocess, server or socket (ADR 0083 decision 1).
pytestmark = pytest.mark.integration


def test_cloud_environment_is_scrubbed() -> None:
    setup = Path(__file__).with_name('conftest.py')
    result = subprocess.run(
        [sys.executable, '-c',
         'import runpy, os, json; runpy.run_path(' + repr(str(setup)) + '); '
         'print(json.dumps({key: os.environ.get(key) for key in '
         '["AWS_REGION", "AWS_DEFAULT_REGION", "TEST_ENV_CONTROL"]}))'],
        env={**os.environ, 'AWS_REGION': 'us-west-2', 'AWS_DEFAULT_REGION': 'us-west-2',
             'TEST_ENV_CONTROL': 'preserved'},
        capture_output=True, text=True, check=True,
    )
    assert json.loads(result.stdout) == {
        'AWS_REGION': None, 'AWS_DEFAULT_REGION': None,
        'TEST_ENV_CONTROL': 'preserved',
    }
