"""Runtime V2 snapshots the Harness at its first healthy /ping; the first agent build must already be in it."""
import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

# Runs a real subprocess (ADR 0083 decision 1).
pytestmark = pytest.mark.integration


def test_main_builds_one_throwaway_agent_before_serving_without_network_or_the_real_workspace(tmp_path: Path) -> None:
    workspace = tmp_path / 'workspace'
    workspace.mkdir()
    program = textwrap.dedent('''
        import json
        import os
        import socket
        import sys
        from pathlib import Path

        attempts = []
        def forbidden(*args, **kwargs):
            attempts.append('network')
            raise AssertionError('the snapshot build must not use the network')
        socket.socket.connect = forbidden
        socket.getaddrinfo = forbidden

        import uvicorn
        from botcube_cartridge import HarnessDefinition
        from botcube_harness_deepagents import serving

        roots = []
        serving.configure_harness_definition(HarnessDefinition(
            skills=[], agent_name='snapshot-fixture', system_prompt='Fixture instructions.',
            prepare_invocation=forbidden, prepare_root=lambda root: roots.append(str(root)),
            build_shell_env=lambda environment: {}, session_id_env_var='TEST_SESSION_ID',
            environment_cache_key=lambda environment: (),
        ))
        built = []
        real_get_agent = serving._get_agent
        def counting(**kwargs):
            built.append(kwargs['model'])
            return real_get_agent(**kwargs)
        serving._get_agent = counting

        def serve(app, **options):
            print(json.dumps({
                'built': built,
                'roots': roots,
                'rootsLeft': [root for root in roots if Path(root).exists()],
                'workspaceEnv': os.environ.get('BOTCUBE_WORKSPACE'),
                'workspaceEntries': sorted(os.listdir(sys.argv[1])),
                'cached': [len(serving._AGENTS), len(serving._BACKENDS), len(serving._BACKEND_BY_AGENT), len(serving._MODEL_RELAYS)],
                'network': len(attempts),
            }))
        uvicorn.run = serve
        serving.main()
    ''')
    result = subprocess.run(
        [sys.executable, '-c', program, str(workspace)],
        capture_output=True, text=True, timeout=120, check=False,
        env={**os.environ, 'BOTCUBE_WORKSPACE': str(workspace), 'AGENTCORE_MEMORY_ID': '', 'BOTCUBE_SNAPSHOT_PRIME': '1'},
    )
    assert result.returncode == 0, result.stderr
    state = json.loads(result.stdout.strip().splitlines()[-1])
    assert len(state['built']) == 1 and state['built'][0].startswith('openai-plan:')
    assert len(state['roots']) == 1 and state['roots'][0] != str(workspace)
    assert state['rootsLeft'] == []
    assert state['workspaceEnv'] == str(workspace)
    assert state['workspaceEntries'] == []
    assert state['cached'] == [0, 0, 0, 0]
    assert state['network'] == 0


def test_after_the_snapshot_build_a_turns_first_model_and_memory_requests_read_no_files(tmp_path: Path) -> None:
    # A V2 restore pays ~38 ms per file access the snapshot never made, so the first request's lazy imports,
    # the SDK's platform probe and botocore's data files must already have been read.
    program = textwrap.dedent('''
        import asyncio
        import json
        import socket
        import sys
        from zoneinfo import ZoneInfo

        def forbidden(*args, **kwargs):
            raise AssertionError('no network')
        socket.socket.connect = forbidden
        socket.getaddrinfo = forbidden

        from botcube_cartridge import HarnessDefinition, ModelRelay
        from botcube_harness_deepagents import serving
        from botcube_harness_deepagents.snapshot_build import answer_once

        serving.configure_harness_definition(HarnessDefinition(
            skills=[], agent_name='snapshot-fixture', system_prompt='Fixture instructions.',
            prepare_invocation=forbidden, prepare_root=lambda root: None,
            build_shell_env=lambda environment: {}, session_id_env_var='TEST_SESSION_ID',
            environment_cache_key=lambda environment: (),
        ))
        serving._prime_snapshot()

        imported = []
        from importlib.machinery import PathFinder
        searched = PathFinder.find_spec
        PathFinder.find_spec = classmethod(lambda cls, name, *args: imported.append(f'search {name}') or searched(name, *args))
        sys.addaudithook(lambda event, args: imported.append(f'{event} {args[0]}') if event in (
            'import', 'open', 'os.listdir', 'os.scandir') and not str(args[0]).endswith('.aws/config') else None)
        relay = ModelRelay(base_url='https://turn.invalid/v1', token='turn', headers={}, session_id='turn')
        agent = serving._get_agent(actor_id='turn', session_user_id='turn', persistent_memory=True,
                                   model=serving._SNAPSHOT_MODEL, thread_id='turn', model_relay=relay)
        # The OpenTelemetry LangGraph instrumentation walks every Turn's graph for its span, importing this lazily.
        from opentelemetry.instrumentation.langchain.langgraph_utils import extract_graph_structure
        extract_graph_structure(agent.graph)
        model = serving.build_model(model=serving._SNAPSHOT_MODEL, max_tokens=16000, relay=lambda: relay)
        asyncio.run(answer_once(model, 'turn'))
        serving.agentcore_memory_backend.prime_memory_client(serving.AGENTCORE_REGION)
        ZoneInfo('America/New_York')
        print(json.dumps(sorted(set(imported))))
    ''')
    result = subprocess.run(
        [sys.executable, '-c', program], capture_output=True, text=True, timeout=120, check=False,
        env={**os.environ, 'BOTCUBE_WORKSPACE': str(tmp_path), 'AGENTCORE_MEMORY_ID': ''},
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout.strip().splitlines()[-1]) == []
