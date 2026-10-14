"""Load a deploy script (hyphenated, so not importable) as a module for tests."""

import importlib.util
import os
from pathlib import Path
from types import ModuleType

os.environ['CARTRIDGE_DEPLOY_ROOT'] = str(Path(__file__).resolve().parents[2] / 'template/deploy')
os.environ['CARTRIDGE_REPOSITORY_ROOT'] = str(Path(__file__).resolve().parents[3])
DEPLOY_ECS = Path(__file__).resolve().parents[1] / 'ecs'


def load_deploy_script(name: str, filename: str) -> ModuleType:
    path = DEPLOY_ECS / filename
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f'Cannot load deploy script {path}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
