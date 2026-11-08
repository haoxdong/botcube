from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.integration
@pytest.mark.skipif(sys.platform != 'linux', reason='Linux mount namespace contract')
def test_efs_mounts_below_session_storage_without_hiding_local_state() -> None:
    probe = Path(__file__).with_name('files_mount_probe.py')
    result = subprocess.run(['unshare', '--user', '--map-root-user', '--mount', '--fork', sys.executable, str(probe)],
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'PASS nested workspace mount' in result.stdout
