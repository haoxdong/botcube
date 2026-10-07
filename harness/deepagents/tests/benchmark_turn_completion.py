from __future__ import annotations

import asyncio
import importlib.util
import json
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path
from time import perf_counter
from types import SimpleNamespace
from typing import Any

from ag_ui.core import EventType, RunAgentInput
from langchain.agents import AgentState
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

REPO = Path(__file__).resolve().parents[4]
SOURCE = 'botcube/harness/deepagents/src/botcube_harness_deepagents/serving.py'


async def sample(source: str) -> dict[str, Any]:
    spec = importlib.util.spec_from_file_location('botcube_harness_deepagents.benchmark_serving', source)
    assert spec is not None and spec.loader is not None
    serving: Any = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = serving
    spec.loader.exec_module(serving)
    graph = StateGraph(AgentState)
    graph.add_node('reply', lambda state: {'messages': [AIMessage('Done', id='answer')]})
    graph.add_edge(START, 'reply')
    graph.add_edge('reply', END)
    compiled = graph.compile(checkpointer=MemorySaver())
    agent = serving._SessionAgent(name='bench', graph=compiled)
    history = [
        HumanMessage('q' * 512, id=f'q{i}') if i % 2 == 0 else AIMessage('a' * 512, id=f'a{i}')
        for i in range(1400)
    ]
    config: RunnableConfig = {'configurable': {'thread_id': 'session'}}
    await compiled.aupdate_state(config, {'messages': history})
    counts = {'pushes': 0, 'saved_snapshots': 0, 'errors': 0, 'finished': 0, 'wire_snapshots': 0, 'messages': 1401}

    def push(*args: Any) -> None:
        counts['pushes'] += 1

    async def snapshot(*args: Any) -> None:
        counts['saved_snapshots'] += 1

    serving._require_cartridge = lambda: SimpleNamespace(skills=())
    serving._snapshot_messages = snapshot
    serving._DEFERRED_SAVER = None
    files = SimpleNamespace(pull=lambda *args: None, push=push)
    data = RunAgentInput(thread_id='session', run_id='bench', messages=[], tools=[], context=[], state={}, forwarded_props={})
    started = perf_counter()
    finished = 0.0
    turns = serving._SessionTurns()
    async for event in turns.stream(
        ('owner', 'session'), agent, data, files, Path('/tmp'), serving._RequestContext(None),
    ):
        if event.type == EventType.RUN_FINISHED:
            finished = perf_counter()
            counts['finished'] += 1
        if event.type == EventType.RUN_ERROR:
            counts['errors'] += 1
        if event.type == EventType.MESSAGES_SNAPSHOT:
            counts['wire_snapshots'] += 1
    eof = perf_counter()
    lock = turns._locks.get(('owner', 'session'))
    if lock is not None:
        async with lock:
            pass
    settled = perf_counter()
    assert counts['finished'] == 1 and counts['errors'] == 0
    assert counts['pushes'] == 1 and counts['saved_snapshots'] == 1
    recorded = (await compiled.aget_state(config)).values['messages']
    assert len(recorded) == 1401 and recorded[-1].content == 'Done'
    return {
        'graph_end_to_finish_ms': (finished - agent._graph_ended_at) * 1000,
        'finish_ms': (finished - started) * 1000,
        'eof_ms': (eof - started) * 1000,
        'settled_ms': (settled - started) * 1000,
        'counts': counts,
    }


def compare() -> None:
    before_ref = sys.argv[1] if len(sys.argv) > 1 else 'd71469e8'
    rows = []
    with tempfile.TemporaryDirectory() as directory:
        before = Path(directory) / 'serving.py'
        before.write_bytes(subprocess.check_output(['git', 'show', f'{before_ref}:{SOURCE}'], cwd=REPO))
        for run in range(1, 6):
            for side, source in [('before', before), ('after', REPO / SOURCE)]:
                output = subprocess.check_output(
                    [sys.executable, str(Path(__file__).resolve()), '--sample', str(source)], cwd=REPO,
                )
                row = json.loads(output)
                row.update(side=side, run=run)
                rows.append(row)
    summary = {}
    for side in ['before', 'after']:
        summary[side] = {}
        for metric in ['graph_end_to_finish_ms', 'finish_ms', 'eof_ms', 'settled_ms']:
            values = [row[metric] for row in rows if row['side'] == side]
            summary[side][metric] = {'median': statistics.median(values), 'min': min(values), 'max': max(values)}
    print(json.dumps({'before_ref': before_ref, 'history_text_bytes': 716800, 'runs': rows, 'summary': summary}, indent=2))


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--sample':
        print(json.dumps(asyncio.run(sample(sys.argv[2]))))
    else:
        compare()
