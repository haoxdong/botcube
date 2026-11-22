"""The Harness reads the one BotCube Config BOTCUBE_CONFIG names, checked against its JSON Schema (ADR 0091).

The loader is a byte-identical copy of the Credential Service's, whose tests cover its behaviour.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from botcube_harness_deepagents import botcube_config

BOTCUBE = Path(__file__).resolve().parents[3]
CANONICAL_SCHEMA = BOTCUBE / 'config' / 'botcube.schema.json'
VENDORED_SCHEMA = Path(botcube_config.__file__).with_name('botcube.schema.json')


def test_the_harness_exits_at_startup_naming_the_file_its_locator_names_but_cannot_find(tmp_path: Path) -> None:
    path = tmp_path / 'absent.json'

    started = subprocess.run([sys.executable, '-m', 'botcube_harness_deepagents.serving'], env={**os.environ, 'BOTCUBE_CONFIG': str(path)},
                             capture_output=True, text=True, timeout=60, check=False)

    assert started.returncode != 0
    assert f'BotCube Config {path}: no file' in started.stderr


def test_the_vendored_schema_is_the_canonical_schema_byte_for_byte() -> None:
    assert VENDORED_SCHEMA.read_bytes() == CANONICAL_SCHEMA.read_bytes()


def test_the_loader_is_byte_identical_to_the_credential_services_which_tests_it() -> None:
    twin = BOTCUBE / 'credential-service/src/botcube_credential_service/botcube_config.py'

    assert Path(botcube_config.__file__).read_bytes() == twin.read_bytes()
