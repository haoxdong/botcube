from __future__ import annotations

import asyncio
import json
import shlex
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from ag_ui.core import EventType, RunAgentInput, UserMessage
from deepagents.backends import LocalShellBackend
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage
from langchain_core.outputs import ChatGenerationChunk
from langgraph.checkpoint.memory import InMemorySaver

from botcube_harness_deepagents import files, publish, serving
from botcube_harness_deepagents.agent import build_agent
from botcube_harness_deepagents.files_mount import FilesMount
from conftest import ToolBindableFakeMessagesModel, prepared
from mounted_files import MountedFiles, binding


class StreamingModel(ToolBindableFakeMessagesModel):
    def _stream(self, messages: list[BaseMessage], *args: Any, **kwargs: Any) -> Iterator[ChatGenerationChunk]:
        message = self._generate(messages, *args, **kwargs).generations[0].message
        yield ChatGenerationChunk(message=AIMessageChunk(content=message.text, id=message.id, tool_call_chunks=[
            {'name': call['name'], 'args': json.dumps(call['args']), 'id': call['id'], 'index': index}
            for index, call in enumerate(getattr(message, 'tool_calls', []))
        ]))


@pytest.mark.integration
def test_a_turn_saves_its_linked_sandbox_pdf_before_finishing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    workspace, filesystem = tmp_path / 'workspace', tmp_path / 'filesystem'
    workspace.mkdir()
    source = filesystem / 'mnt/data/report.pdf'
    pdf = Path(__file__).with_name('fixtures') / 'sandbox-report.pdf'
    answer = '[Download report](/mnt/data/report.pdf)'
    monkeypatch.setattr(serving, '_require_cartridge', lambda: SimpleNamespace(skills=()))
    monkeypatch.setattr(publish, 'import_linked_files', lambda root, text, excluded: files.import_linked_files(
        root, text, excluded, filesystem=filesystem,
    ), raising=False)
    model = StreamingModel(responses=[
        AIMessage(content='', id='create', tool_calls=[{
            'id': 'write-pdf', 'name': 'execute',
            'args': {'command': f'mkdir -p {shlex.quote(str(source.parent))} && cp {shlex.quote(str(pdf))} {shlex.quote(str(source))}'},
        }]),
        AIMessage(content=answer, id='answer'),
    ])
    graph = build_agent(
        model=model, backend=LocalShellBackend(root_dir=workspace, virtual_mode=True, inherit_env=False),
        skills=[], checkpointer=InMemorySaver(),
    )
    agent = serving._SessionAgent(name='linked-files', graph=graph)
    request = RunAgentInput(
        thread_id='linked-files', run_id='linked-run',
        messages=[UserMessage(id='question', role='user', content='Write and link a PDF in /mnt/data.')],
        tools=[], context=[], state={}, forwarded_props={},
    )
    mounted = MountedFiles(workspace)
    monkeypatch.setattr(FilesMount, 'pull', lambda mount, root, excluded=(): mounted.mount(mount, root, excluded))
    mount = FilesMount.from_binding(binding())

    async def exercise() -> None:
        events = []
        async for event in serving._SessionTurns().stream(
            ('owner', 'linked-files'), prepared(agent, workspace), request, mount, serving._RequestContext(None),
        ):
            events.append(event)
            if event.type == EventType.RUN_FINISHED:
                assert mounted.read('mnt/data/report.pdf') == pdf.read_bytes()
        assert events[-1].type == EventType.RUN_FINISHED
        assert ''.join(event.delta for event in events if event.type == EventType.TEXT_MESSAGE_CONTENT) == answer
        state = await graph.aget_state({'configurable': {'thread_id': 'linked-files'}})
        assert state.values['messages'][-1].content == answer

    asyncio.run(exercise())


def test_link_import_preserves_files_and_excludes_scratch_and_nonfiles(tmp_path: Path) -> None:
    workspace, filesystem = tmp_path / 'workspace', tmp_path / 'filesystem'
    workspace.mkdir()
    for name in ('mnt/data/monthly report.pdf', 'report.pdf', 'tmp/scratch.pdf', '.secret.pdf', 'skill/example.pdf'):
        path = filesystem / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'shell file')
    (workspace / 'report.pdf').write_bytes(b'existing file')
    (filesystem / 'mnt/data/link.pdf').symlink_to(filesystem / 'report.pdf')
    answer = (
        '[Download report](</mnt/data/monthly%20report.pdf> "Report") '
        '[Existing](/report.pdf) [Missing](/missing.pdf) [Scratch](/tmp/scratch.pdf) '
        '[Hidden](/.secret.pdf) [Skill](/skill/example.pdf) [Link](/mnt/data/link.pdf) '
        '[Directory](/mnt/data) [Traversal](/../report.pdf) [Web](https://example.com/report.pdf)'
    )

    files.import_linked_files(workspace, answer, files.excluded_paths(('skill',)), filesystem)

    assert sorted(path.relative_to(workspace).as_posix() for path in workspace.rglob('*') if path.is_file()) == [
        'mnt/data/monthly report.pdf', 'report.pdf',
    ]
    assert (workspace / 'mnt/data/monthly report.pdf').read_bytes() == b'shell file'
    assert (workspace / 'report.pdf').read_bytes() == b'existing file'
    assert (filesystem / 'mnt/data/monthly report.pdf').read_bytes() == b'shell file'


@pytest.mark.parametrize('name', ['etc/hostname', 'root/runtime.env', 'proc/self/environ', 'mnt/database/report.pdf', 'mnt/data/escape/hostname'])
def test_link_import_does_not_persist_container_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, name: str,
) -> None:
    workspace, filesystem = tmp_path / 'workspace', tmp_path / 'filesystem'
    workspace.mkdir()
    outside = filesystem / 'etc/hostname'
    outside.parent.mkdir(parents=True)
    outside.write_bytes(b'container file')
    if name == 'mnt/data/escape/hostname':
        sandbox = filesystem / 'mnt/data'
        sandbox.mkdir(parents=True)
        (sandbox / 'escape').symlink_to(outside.parent, target_is_directory=True)
    else:
        source = filesystem / name
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(b'container file')

    files.import_linked_files(workspace, f'[Download](/{name})', (), filesystem)
    assert not list(workspace.rglob('*'))
    assert 'outside artifact directories' in caplog.text
    assert 'container file' not in caplog.text


def test_link_import_allows_files_from_the_files_workspace(tmp_path: Path) -> None:
    filesystem = tmp_path / 'filesystem'
    workspace = filesystem / 'workspace'
    workspace.mkdir(parents=True)
    (workspace / 'report.pdf').write_bytes(b'workspace file')

    files.import_linked_files(workspace, '[Download](/workspace/report.pdf)', (), filesystem)

    assert (workspace / 'workspace/report.pdf').read_bytes() == b'workspace file'


@pytest.mark.parametrize('name', ['tmp/scratch.pdf', 'skill/example.pdf'])
def test_workspace_sources_keep_their_files_exclusions(tmp_path: Path, name: str) -> None:
    filesystem = tmp_path / 'filesystem'
    workspace = filesystem / 'workspace'
    source = workspace / name
    source.parent.mkdir(parents=True)
    source.write_bytes(b'excluded file')

    files.import_linked_files(workspace, f'[Download](/workspace/{name})', files.excluded_paths(('skill',)), filesystem)

    assert not (workspace / 'workspace' / name).exists()
