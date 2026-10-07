from __future__ import annotations

import os
from pathlib import Path
from typing import Any

DEFAULT_MEMORY_RELATIVE_PATH = Path('.tmp/botcube-harness-deepagents/memory.md')
STANDALONE_MEMORY_RELATIVE_PATH = Path('botcube-harness-deepagents/memory.md')
MEMORY_FILENAME = 'memory.md'
LTM_FILENAME = 'ltm.md'


def default_memory_path(repo_root: Path | str | None = None) -> Path:
    return _default_memory_path_and_source(repo_root)[0]


def ensure_memory_file(path: Path | str) -> Path:
    memory_path = Path(path)
    memory_path.parent.mkdir(parents=True, exist_ok=True)
    memory_path.touch(exist_ok=True)
    return memory_path


def build_memory_sources(
    *,
    memory_path: Path | str | None = None,
    repo_root: Path | str | None = None,
    backend: Any = None,
) -> list[str]:
    path, source = resolve_memory_source(
        filename=MEMORY_FILENAME,
        memory_path=memory_path,
        repo_root=repo_root,
        backend=backend,
    )
    ensure_memory_file(path)
    return [source]


def write_ltm_source(
    content: str,
    *,
    backend: Any = None,
    memory_path: Path | str | None = None,
    repo_root: Path | str | None = None,
) -> str:
    """Write prewarmed LTM beside the memory file; return its source path."""
    path, source = resolve_memory_source(
        filename=LTM_FILENAME,
        memory_path=memory_path,
        repo_root=repo_root,
        backend=backend,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    return source


def resolve_memory_source(
    *,
    filename: str,
    memory_path: Path | str | None = None,
    repo_root: Path | str | None = None,
    backend: Any = None,
) -> tuple[Path, str]:
    memory_path = memory_path or os.getenv('BOTCUBE_MEMORY_PATH')
    if memory_path is not None:
        configured = Path(memory_path)
        path = configured if filename == MEMORY_FILENAME else configured.with_name(filename)
        return _source_for_backend(path, backend)

    backend_root = _virtual_root(backend)
    if backend_root is not None:
        default_source = _virtual_default_memory_path_and_source(repo_root, backend_root)
        if default_source is not None:
            path, source = default_source
            if filename == path.name:
                return path, source
            return path.with_name(filename), f"{source.rsplit('/', 1)[0]}/{filename}"

        relative = Path('tmp') / STANDALONE_MEMORY_RELATIVE_PATH.with_name(filename)
        return backend_root / relative, f'/{relative.as_posix()}'

    path, source = _default_memory_path_and_source(repo_root)
    if filename == path.name:
        return path, source
    return path.with_name(filename), f"{source.rsplit('/', 1)[0]}/{filename}"


def _source_for_backend(path: Path, backend: Any) -> tuple[Path, str]:
    backend_root = _virtual_root(backend)
    if backend_root is None:
        return path, str(path)

    root = backend_root.resolve()
    resolved = path.resolve()
    try:
        relative = resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError(
            f'memory_path {path} must be under virtual backend root {root}'
        ) from exc
    return resolved, f'/{relative.as_posix()}'


def _virtual_root(backend: Any) -> Path | None:
    """The root directory of a virtual-mode backend, or None for a real filesystem."""
    if backend is None or not backend.virtual_mode:
        return None
    return Path(backend.cwd)


def _virtual_default_memory_path_and_source(
    repo_root: Path | str | None,
    backend_root: Path,
) -> tuple[Path, str] | None:
    backend_root = backend_root.resolve()
    root = (
        Path(repo_root).resolve()
        if repo_root is not None
        else _maybe_find_workspace_root(backend_root)
    )
    if root is None:
        return None

    path = root / DEFAULT_MEMORY_RELATIVE_PATH
    try:
        source = path.resolve().relative_to(backend_root)
    except ValueError:
        return None
    return path, f'/{source.as_posix()}'


def _default_memory_path_and_source(
    repo_root: Path | str | None = None,
) -> tuple[Path, str]:
    if repo_root is not None:
        path = Path(repo_root) / DEFAULT_MEMORY_RELATIVE_PATH
        return path, f'/{DEFAULT_MEMORY_RELATIVE_PATH.as_posix()}'

    root = _maybe_find_workspace_root()
    if root is not None:
        path = root / DEFAULT_MEMORY_RELATIVE_PATH
        return path, f'/{DEFAULT_MEMORY_RELATIVE_PATH.as_posix()}'

    source = Path('tmp') / STANDALONE_MEMORY_RELATIVE_PATH
    path = Path.home() / source
    return path, f'/{source.as_posix()}'


def _maybe_find_workspace_root(start: Path | str | None = None) -> Path | None:
    current = Path(start or __file__).resolve()
    if current.is_file():
        current = current.parent
    for candidate in (current, *current.parents):
        if (candidate / '.git').exists() or (
            (candidate / 'package.json').is_file()
            and (candidate / 'botcube').is_dir()
        ):
            return candidate
    return None
