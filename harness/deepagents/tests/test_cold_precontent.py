from __future__ import annotations

from pathlib import Path

import pytest
from deepagents.backends import LocalShellBackend
from langchain_core.tools import tool

from botcube_harness_deepagents import agent, serving
from conftest import ToolBindableFakeModel

pytestmark = pytest.mark.integration


def test_static_skill_roots_survive_snapshot_but_user_roots_still_resolve(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    skills = tmp_path / 'static-skills'
    skills.mkdir()
    (skills / 'guide.txt').write_text('static guide')
    roots = [tmp_path / 'snapshot', tmp_path / 'user-turn']
    for root in roots:
        root.mkdir()

    @tool
    def status() -> str:
        """Read the test status."""
        return 'ok'

    status.metadata = {agent.TOOL_SKILLS: {'/skills/static/': str(skills)}}
    original = Path.resolve
    resolved: list[Path] = []

    def resolving(path: Path, *args, **kwargs):
        resolved.append(path)
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, 'resolve', resolving)
    for index, root in enumerate(roots):
        if index:
            for cache in (serving._AGENTS, serving._BACKENDS, serving._BACKEND_BY_AGENT, serving._MODEL_RELAYS):
                cache.clear()
            resolved.clear()
        agent.build_agent(
            model=ToolBindableFakeModel(responses=['ok']), tools=[status], skills=[],
            backend=LocalShellBackend(root_dir=root, virtual_mode=True, inherit_env=False),
        )
    assert skills not in resolved, 'The restored graph resolved the static skill folder again'
    assert roots[1] in resolved, 'The User Files root must still resolve for its Turn'
    folder = agent.tool_skills([status])['/skills/static/']
    assert folder.read('/guide.txt').file_data['content'] == 'static guide'
    assert folder.write('/guide.txt', 'changed').error
    outside = tmp_path / 'outside.txt'
    outside.write_text('private')
    (skills / 'escape.txt').symlink_to(outside)
    with pytest.raises(ValueError):
        folder.read('/escape.txt')


def test_relative_skill_roots_follow_the_turn_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    @tool
    def status() -> str:
        """Read the test status."""
        return 'ok'

    status.metadata = {agent.TOOL_SKILLS: {'/skills/': 'skills'}}
    for name in ('first', 'second'):
        root = tmp_path / name
        (root / 'skills').mkdir(parents=True)
        (root / 'skills/guide.txt').write_text(name)
        monkeypatch.chdir(root)
        folder = agent.tool_skills([status])['/skills/']
        assert folder.read('/guide.txt').file_data['content'] == name
