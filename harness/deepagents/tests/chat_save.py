"""The Chat Service's own save of a User's edit (`botcube/chat/src/artifact-save.ts`), run against a Files root."""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

CHAT = Path(__file__).resolve().parents[3] / 'chat'
ENTRY = Path(__file__).with_suffix('.ts')

BANNER = "import{createRequire as __chatCreateRequire}from'node:module';const require=__chatCreateRequire(import.meta.url);"

UserSave = Callable[[Path, str, int, dict[str, str]], dict[str, Any]]


def chat_service_save(folder: Path) -> UserSave:
    """Bundles the Chat Service's save into `folder`; the result saves as the panel's Save does."""
    bundle = folder / 'user-save.mjs'
    subprocess.run(
        [str(CHAT / 'node_modules/.bin/esbuild'), str(ENTRY), '--bundle', '--platform=node', '--format=esm',
         f'--banner:js={BANNER}', '--log-level=warning', f'--outfile={bundle}'],
        cwd=CHAT, check=True, capture_output=True, text=True,
    )

    def save(root: Path, identity: str, version: int, files: dict[str, str]) -> dict[str, Any]:
        run = subprocess.run(
            ['node', str(bundle), str(root), json.dumps({'id': identity, 'version': version, 'files': files})],
            capture_output=True, text=True, timeout=60, check=False,
        )
        if run.returncode != 0:
            raise RuntimeError(f'The Chat Service refused the save: {run.stderr.strip()}')
        return json.loads(run.stdout)

    return save
