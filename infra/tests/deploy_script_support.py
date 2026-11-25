"""Load a deploy script (hyphenated, so not importable) as a module for tests."""

import importlib.util
import os
import subprocess
import tempfile
from pathlib import Path
from types import ModuleType

BOTCUBE = Path(__file__).resolve().parents[2]
PUBLIC = BOTCUBE / 'examples/public/botcube.yaml'


def resolve_config(source: Path, target: Path) -> Path:
    with target.open('w') as output:
        subprocess.run(['node', str(BOTCUBE / 'config/cli.ts'), 'resolve', str(source)], stdout=output, check=True)
    return target


_config_dir = tempfile.TemporaryDirectory()
os.environ['BOTCUBE_CONFIG'] = str(resolve_config(PUBLIC, Path(_config_dir.name) / 'resolved.json'))
os.environ['BOTCUBE_DEPLOY_ROOT'] = str(PUBLIC.parent / 'deploy')
DEPLOY_ECS = Path(__file__).resolve().parents[1] / 'ecs'


def load_deploy_script(name: str, filename: str) -> ModuleType:
    path = DEPLOY_ECS / filename
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f'Cannot load deploy script {path}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
