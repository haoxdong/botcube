"""The checker (the `artifact-check` Node package beside this harness), which holds a typed Artifact's Source to its
Artifact Type's format. Each error names the file, the element and the nearest allowed form.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

CHECKOUT_CHECKER = Path(__file__).resolve().parents[2] / 'artifact-check/src/cli.mjs'
# The image installs the harness into a venv, so the package is not beside it there; the Dockerfile copies it here.
IMAGE_CHECKER = Path('/opt/artifact-check/src/cli.mjs')
CHECKER = CHECKOUT_CHECKER if CHECKOUT_CHECKER.is_file() else IMAGE_CHECKER
# The checker CLI's exit code for a Source with errors; any code but this and 0 is the checker itself failing.
FOUND_ERRORS = 3


def errors(type_name: str, source: Path, name: str | None = None) -> list[str]:
    """Every error in the `type_name` Source at `source` (a folder, or one file the checker reads as `name`), as the
    agent reads it; an empty list when it may be published."""
    run = subprocess.run(
        ['node', str(CHECKER), type_name, str(source), *([name] if name else [])],
        capture_output=True, text=True, timeout=60, check=False,
    )
    if run.returncode not in (0, FOUND_ERRORS):
        raise RuntimeError(f'The {type_name} checker failed (exit {run.returncode}): {run.stderr.strip()}')
    return [error['text'] for error in json.loads(run.stdout)['errors']]
