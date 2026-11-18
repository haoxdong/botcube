"""The actual deploy guard rejects an unfinished prepared origin before deploy."""
import os
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.integration


@pytest.mark.parametrize('prepared,expected', [('true', 1), ('false', 0), ('None', 0)])
def test_deploy_guard_rejects_prepared_origin(tmp_path, prepared, expected):
    workflow = (Path(__file__).resolve().parents[3] / '.github/workflows/deploy-preview-origin.yml').read_text()
    start = workflow.index('          require_stored_park_state()')
    end = workflow.index('          # cdk deploy', start)
    guard = '\n'.join(line[10:] for line in workflow[start:end].splitlines())
    aws = tmp_path / 'aws'
    aws.write_text('''#!/bin/bash
case "$*" in
  *get-parameter*) echo parked ;;
  *list-state-machines*) echo None ;;
  *StackStatus*) echo UPDATE_COMPLETE ;;
  *prepareOrigin*) echo "$PREPARED" ;;
  *productionMode*) echo parked ;;
  *) exit 99 ;;
esac
''')
    aws.chmod(0o755)
    result = subprocess.run(['bash', '-c', guard + '\nrequire_stored_park_state'],
                            env={**os.environ, 'PATH': str(tmp_path) + ':' + os.environ['PATH'],
                                 'PRODUCTION_MODE': 'parked', 'PREPARED': prepared}, capture_output=True, text=True)
    assert result.returncode == expected, result.stderr
    if expected:
        assert 'prepareOrigin' in result.stderr
