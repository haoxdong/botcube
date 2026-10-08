from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path


def test_agentcore_fake_tests_run_without_private_repository(tmp_path: Path) -> None:
    tests = Path(__file__).parent
    for filename in ('agentcore_fake.py', 'test_agentcore_fake.py'):
        shutil.copyfile(tests / filename, tmp_path / filename)

    result = subprocess.run(
        [sys.executable, '-m', 'pytest', 'test_agentcore_fake.py', '-q'],
        cwd=tmp_path, capture_output=True, text=True, timeout=30, check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert '1 passed' in result.stdout
