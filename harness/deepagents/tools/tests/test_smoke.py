from __future__ import annotations

import ast
import sys
import tomllib
from importlib.metadata import packages_distributions
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from smoke import main


def test_writes_every_export_type(tmp_path: Path) -> None:
    main(tmp_path)
    assert {path.suffix for path in tmp_path.iterdir()} == {'.pptx', '.xlsx', '.docx', '.pdf', '.png'}


def test_missing_system_program_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('PATH', '')
    with pytest.raises(FileNotFoundError):
        main(tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_every_pinned_distribution_is_imported() -> None:
    root = Path(__file__).resolve().parents[1]
    manifest = tomllib.loads((root / 'pyproject.toml').read_text())
    dependency_names = {item.split('==')[0].lower().replace('_', '-') for item in manifest['project']['dependencies']}
    imports = {alias.name for node in ast.walk(ast.parse((root / 'smoke.py').read_text()))
               if isinstance(node, ast.Import) for alias in node.names}
    distribution_names = {distribution.lower().replace('_', '-') for module in imports
                          for distribution in packages_distributions().get(module, [])}
    assert dependency_names <= distribution_names
    assert all('==' in item for item in manifest['project']['dependencies'])
