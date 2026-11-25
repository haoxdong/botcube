"""Runtime V2 primes the Harness through its memory warmup hook before capturing the snapshot."""
import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

# Runs a real subprocess (ADR 0083 decision 1).
pytestmark = pytest.mark.integration


@pytest.mark.parametrize('snapshot_build', [False, True])
def test_only_a_snapshot_build_primes_the_harness_without_network_or_the_real_workspace(
    tmp_path: Path, snapshot_build: bool,
) -> None:
    workspace = tmp_path / 'workspace'
    workspace.mkdir()
    program = textwrap.dedent('''
        import json
        import os
        import socket
        import sys
        from functools import partial
        from pathlib import Path

        attempts = []
        def forbidden(*args, **kwargs):
            attempts.append('network')
            raise AssertionError('the snapshot build must not use the network')
        socket.socket.connect = forbidden
        socket.getaddrinfo = forbidden

        import uvicorn
        from botcube_harness_deepagents.definition import HarnessDefinition
        from botcube_harness_deepagents import aws_clients, restore_prime, serving

        prepared_root = Path(sys.argv[1]).parent / 'restore'
        restore_prime.prime = partial(restore_prime.prime, root=prepared_root, mount=lambda command: None)

        roots = []
        serving.configure_harness_definition(HarnessDefinition(
            skills=[], agent_name='snapshot-fixture', system_prompt='Fixture instructions.',
            prepare_invocation=forbidden, prepare_root=lambda root: roots.append(str(root)),
            session_id_env_var='TEST_SESSION_ID',
            environment_cache_key=lambda environment: (),
        ))
        built = []
        real_get_agent = serving._get_agent
        def counting(**kwargs):
            built.append(kwargs['model'])
            return real_get_agent(**kwargs)
        serving._get_agent = counting

        def serve(app, **options):
            from fastapi.testclient import TestClient
            assert not prepared_root.exists()
            with TestClient(app) as client:
                assert client.get('/ping').status_code == 200
                assert not prepared_root.exists()
                if sys.argv[2] == 'True':
                    response = client.post('/warmup', headers={
                        'X-Amzn-Bedrock-AgentCore-Runtime-Warmup-Type': 'memory'})
                    assert response.status_code == 200, response.text
                    assert prepared_root.is_dir()
            spare = serving.agentcore_memory_backend._SPARE
            clients = ([serving.agentcore_memory_backend.sts_client(serving.AWS_REGION),
                        *aws_clients.bedrock(serving.AWS_REGION)] if sys.argv[2] == 'True' else [])
            if spare is not None:
                clients.append(spare[0].client)
            print(json.dumps({
                'built': built,
                'roots': roots,
                'rootsLeft': [root for root in roots if Path(root).exists()],
                'workspaceEnv': os.environ.get('BOTCUBE_WORKSPACE'),
                'workspaceEntries': sorted(os.listdir(sys.argv[1])),
                'cached': [len(serving._AGENTS), len(serving._BACKENDS), len(serving._BACKEND_BY_AGENT), len(serving._MODEL_RELAYS)],
                'network': len(attempts),
                'transportVerifyPaths': [client._endpoint.http_session._verify for client in clients],
                'preparedBundle': str(prepared_root / 'aws_ca_bundle.pem'),
                'spareUnbound': spare is not None and spare[1].sandbox is None,
                'memoryUnbound': serving.agentcore_memory_backend._MEMORY is None,
            }))
        uvicorn.run = serve
        serving.main()
        if sys.argv[2] == 'False':
            serving.main()
    ''')
    result = subprocess.run(
        [sys.executable, '-c', program, str(workspace), str(snapshot_build)],
        capture_output=True, text=True, timeout=120, check=False,
        env={**os.environ, 'BOTCUBE_WORKSPACE': str(workspace), 'AGENTCORE_MEMORY_ID': 'snapshot',
             'AWS_ACCESS_KEY_ID': 'snapshot' if snapshot_build else '',
             'AWS_SECRET_ACCESS_KEY': 'snapshot' if snapshot_build else '',
             'AWS_SESSION_TOKEN': 'snapshot' if snapshot_build else '', 'AWS_DEFAULT_REGION': 'us-east-1'},
    )
    assert result.returncode == 0, result.stderr
    state = json.loads(result.stdout.strip().splitlines()[-1])
    assert len(state['built']) == (1 if snapshot_build else 0)
    assert len(state['roots']) == (1 if snapshot_build else 0)
    assert all(root != str(workspace) for root in state['roots'])
    assert state['rootsLeft'] == []
    assert state['workspaceEnv'] == str(workspace)
    assert state['workspaceEntries'] == []
    assert state['cached'] == [0, 0, 0, 0]
    assert state['network'] == 0
    assert state['memoryUnbound']
    assert state['spareUnbound'] == snapshot_build
    if snapshot_build:
        assert state['transportVerifyPaths'] == [state['preparedBundle']] * 4


def test_after_the_snapshot_build_a_turns_first_model_and_memory_requests_read_no_files(
    tmp_path: Path,
) -> None:
    artifact_skills = tmp_path / 'image-skills'
    artifact_skills.mkdir()
    aws_config = tmp_path / 'aws-config'
    aws_config.write_text('[default]\nregion = us-east-1\n')
    program = textwrap.dedent('''
        import asyncio
        import json
        import os
        import socket
        import sys
        from datetime import UTC, datetime, timedelta
        from pathlib import Path
        from unittest.mock import patch
        from zoneinfo import ZoneInfo

        def forbidden(*args, **kwargs):
            raise AssertionError('no network')
        socket.socket.connect = forbidden
        socket.getaddrinfo = forbidden

        from botcube_harness_deepagents.definition import HarnessDefinition, ModelRelay
        from botcube_harness_deepagents import artifact, serving
        from botcube_harness_deepagents.snapshot_build import answer_once

        artifact.SKILLS = Path(sys.argv[1])
        serving.configure_harness_definition(HarnessDefinition(
            skills=[], agent_name='snapshot-fixture', system_prompt='Fixture instructions.',
            prepare_invocation=forbidden, prepare_root=lambda root: None,
            session_id_env_var='TEST_SESSION_ID',
            environment_cache_key=lambda environment: (),
        ))
        serving.restore_prime.prime = lambda region: None
        serving._prime_snapshot()
        memory = serving.agentcore_memory_backend
        from botocore.awsrequest import AWSResponse
        from botocore.compat import HTTPHeaders

        class Body:
            def stream(self, **kwargs):
                yield b'{"events": []}'

        signed = []
        def answer(request, **kwargs):
            signed.append((request.headers['Authorization'].decode(),
                           request.headers['X-Amz-Security-Token'].decode()))
            return AWSResponse(request.url, 200, HTTPHeaders(), Body())

        identity = {
            'actorId': 'turn', 'filingActorId': 'turn', 'sessionId': 'turn', 'writesPrefix': '/turn',
            'turnId': 'turn', 'accessKeyId': 'turn-key', 'secretAccessKey': 'turn-secret',
            'sessionToken': 'turn-token', 'expiration': (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
        }

        imported = []
        from importlib.machinery import PathFinder
        searched = PathFinder.find_spec
        PathFinder.find_spec = classmethod(lambda cls, name, *args: imported.append(f'search {name}') or searched(name, *args))
        sys.addaudithook(lambda event, args: imported.append(f'{event} {args[0]}') if event in (
            'import', 'open', 'os.listdir', 'os.scandir') else None)
        relay = ModelRelay(base_url='https://turn.invalid/v1', token='turn', headers={}, session_id='turn')
        lstat = os.lstat
        def record_artifact_skill_lookup(path, *args, **kwargs):
            if os.fsdecode(path) == str(artifact.SKILLS):
                imported.append(f'lstat {path}')
            return lstat(path, *args, **kwargs)
        with patch.object(os, 'lstat', record_artifact_skill_lookup):
            agent = serving._get_agent(actor_id='turn', session_user_id='turn', persistent_memory=True, written_memory=True,
                                       model=serving._SNAPSHOT_MODEL, thread_id='turn', model_relay=relay,
                                       syncs_files=True)
        # The OpenTelemetry LangGraph instrumentation walks every Turn's graph for its span, importing this lazily.
        from opentelemetry.instrumentation.langchain.langgraph_utils import extract_graph_structure
        extract_graph_structure(agent.graph)
        model = serving.build_model(model=serving._SNAPSHOT_MODEL, max_tokens=16000, relay=lambda: relay)
        asyncio.run(answer_once(model, 'turn'))
        _, store = memory.turn_memory('snapshot-memory', identity, region_name=serving.AWS_REGION,
                                      run_id='turn', turn=memory.next_turn())
        store.client.meta.events.register_first('before-send.bedrock-agentcore.ListEvents', answer)
        assert store.client.list_events(memoryId=store.memory_id, actorId='turn', sessionId='turn')['events'] == []
        assert 'Credential=turn-key/' in signed[-1][0] and signed[-1][1] == 'turn-token'
        try:
            memory.turn_memory('snapshot-memory', {**identity, 'sessionId': 'other-session'},
                               region_name=serving.AWS_REGION, run_id='other', turn=memory.next_turn())
        except memory.MemorySandboxError:
            pass
        else:
            raise AssertionError('a restored Memory client must refuse another sandbox')
        ZoneInfo('America/New_York')
        print(json.dumps(sorted(set(imported))))
    ''')
    result = subprocess.run(
        [sys.executable, '-c', program, str(artifact_skills)], capture_output=True, text=True, timeout=120, check=False,
        env={**os.environ, 'BOTCUBE_WORKSPACE': str(tmp_path), 'AGENTCORE_MEMORY_ID': 'snapshot-memory',
             'AWS_CONFIG_FILE': str(aws_config),
             'AWS_ACCESS_KEY_ID': '', 'AWS_SECRET_ACCESS_KEY': '', 'AWS_SESSION_TOKEN': '', 'AWS_PROFILE': 'default',
             'AWS_SHARED_CREDENTIALS_FILE': str(tmp_path / 'no-credentials'),
             'AWS_CONTAINER_CREDENTIALS_FULL_URI': 'http://127.0.0.1:9/credentials', 'AWS_DEFAULT_REGION': 'us-east-1'},
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout.strip().splitlines()[-1]) == []


def test_new_actor_discovers_and_reads_primed_artifact_skills_without_filesystem_calls(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import asyncio
    import os
    import sys
    from unittest.mock import patch

    from langchain_core.messages import AIMessage, ToolMessage
    from langchain_core.runnables import RunnableConfig

    from botcube_harness_deepagents import artifact, serving
    from botcube_harness_deepagents.agent import tool_skills
    from botcube_harness_deepagents.definition import (
        HarnessDefinition,
        InvocationAuth,
        ModelRelay,
    )
    from conftest import ToolBindableFakeMessagesModel

    skills = tmp_path / 'image-skills'
    guide = skills / 'artifacts' / 'SKILL.md'
    guide.parent.mkdir(parents=True)
    content = '---\nname: artifacts\ndescription: Publish an artifact.\n---\nGuide text.\n'
    guide.write_text(content)
    (guide.parent / 'guide.md').write_text('Artifact guidance from the image.')
    monkeypatch.setattr(artifact, 'SKILLS', skills)
    workspace = tmp_path / 'user-workspace'
    monkeypatch.setenv('BOTCUBE_WORKSPACE', str(workspace))
    for name in ('_AGENTS', '_BACKENDS', '_BACKEND_BY_AGENT', '_MODEL_RELAYS'):
        monkeypatch.setattr(serving, name, {})
    for name in ('_bot', '_CHECKPOINTER', '_STORE'):
        monkeypatch.setattr(serving, name, None)
    serving.configure_harness_definition(HarnessDefinition(
        skills=[], agent_name='snapshot-fixture', system_prompt='Fixture instructions.',
        prepare_invocation=lambda _, _token: InvocationAuth(None, False, None),
        prepare_root=lambda _: None, session_id_env_var='TEST_SESSION_ID',
        environment_cache_key=lambda _: (),
    ))
    monkeypatch.setattr(serving.restore_prime, 'prime', lambda _: None)
    monkeypatch.setattr(serving.agentcore_memory_backend, 'prime_memory_client', lambda _: None)
    monkeypatch.setattr(serving.aws_clients, 'prime', lambda _: None)
    monkeypatch.setattr(serving, 'AGENTCORE_MEMORY_ID', '')
    monkeypatch.setattr(serving, 'build_model', lambda **_: ToolBindableFakeMessagesModel(responses=[
        AIMessage(content='', tool_calls=[{
            'name': 'read_file', 'args': {'file_path': f'{artifact.SKILLS_SOURCE}artifacts/guide.md'}, 'id': 'guide',
        }]),
        AIMessage(content='ok'),
    ]))

    async def answer(*_):
        pass

    monkeypatch.setattr(serving, 'answer_once', answer)
    serving._prime_snapshot()

    touched = []
    observing = True

    def record(event, path):
        if observing and isinstance(path, (str, bytes, Path)) and Path(os.fsdecode(path)).is_relative_to(skills):
            touched.append((event, os.fsdecode(path)))

    def audit(event, args):
        if event in ('open', 'os.listdir', 'os.scandir'):
            record(event, args[0])

    def observe(operation):
        original = getattr(os, operation)

        def wrapped(path, *args, **kwargs):
            record(operation, path)
            return original(path, *args, **kwargs)

        return wrapped

    sys.addaudithook(audit)
    try:
        with patch.multiple(os, stat=observe('stat'), lstat=observe('lstat'), readlink=observe('readlink')):
            relay = ModelRelay(base_url='https://turn.invalid/v1', token='turn', headers={}, session_id='turn')
            agent = serving._get_agent(
                actor_id='turn', session_user_id='turn', thread_id='turn', persistent_memory=False, written_memory=True,
                model=serving._SNAPSHOT_MODEL, model_relay=relay, syncs_files=True,
            )
            config: RunnableConfig = {'configurable': {'thread_id': 'turn', 'actor_id': 'turn'}}
            state = asyncio.run(agent.graph.ainvoke({'messages': [('user', 'Reply ok.')]}, config))
            assert state['messages'][-1].content == 'ok'
            tool_reply, = (message for message in state['messages'] if isinstance(message, ToolMessage))
            assert 'Artifact guidance from the image.' in tool_reply.content
            checkpoint = agent.graph.get_state(config)
            assert [skill['name'] for skill in checkpoint.values['skills_metadata']] == ['artifacts']
            folder = tool_skills([artifact.artifact_tool(workspace)])[artifact.SKILLS_SOURCE]
            guide_file, missing = asyncio.run(folder.adownload_files(['/artifacts/SKILL.md', '/missing.md']))
            assert guide_file.content == content.encode()
            assert missing.error == 'file_not_found'
            assert asyncio.run(folder.awrite('/artifacts/SKILL.md', 'changed')).error
    finally:
        observing = False
    assert touched == []
