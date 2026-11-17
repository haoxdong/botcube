import subprocess
import sys
import textwrap

import pytest

# Runs a real subprocess, server or socket (ADR 0083 decision 1).
pytestmark = pytest.mark.integration


def test_first_plan_model_needs_no_sdk_resource_imports_after_runtime_is_ready() -> None:
    result = subprocess.run(
        [sys.executable, '-c', textwrap.dedent('''
            import asyncio
            import importlib.abc
            import socket
            import sys

            import uvicorn
            from botcube_cartridge import HarnessDefinition, ModelRelay
            from botcube_harness_deepagents import serving
            from botcube_harness_deepagents.llm import build_model

            def forbidden(*args, **kwargs):
                raise AssertionError('Bootstrap must not access an account or the network')

            socket.socket.connect = forbidden
            serving.configure_harness_definition(HarnessDefinition(
                skills=[], agent_name='bootstrap-test', system_prompt='',
                prepare_invocation=forbidden, prepare_root=forbidden,
                build_shell_env=forbidden,
                session_id_env_var='TEST_SESSION_ID', environment_cache_key=forbidden,
            ))

            class NoLateResources(importlib.abc.MetaPathFinder):
                def find_spec(self, fullname, path=None, target=None):
                    if fullname == 'openai.resources' or fullname.startswith('openai.resources.'):
                        raise AssertionError(f'SDK resource imported after readiness: {fullname}')
                    return None

            def ready(app, **options):
                sys.meta_path.insert(0, NoLateResources())
                relay = ModelRelay('http://127.0.0.1:1/openai/v1', 'fixture', {}, 'session')
                model = build_model(model='openai-plan:gpt-6-astra', relay=lambda: relay)
                assert model.model_name == 'gpt-6-astra'
                assert model.streaming is True
                # The first request reaches the SDK's Responses resource.
                assert model.root_async_client.responses is not None
                model.root_client.close()
                asyncio.run(model.root_async_client.close())
                print('plan model ready without late SDK resources')

            uvicorn.run = ready
            serving.main()
        ''')],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == 'plan model ready without late SDK resources'


def test_first_memory_exchange_needs_no_sts_client_build_after_readiness() -> None:
    result = subprocess.run(
        [sys.executable, '-c', textwrap.dedent('''
            import os
            os.environ['AGENTCORE_MEMORY_ID'] = 'memory_1-0123456789'
            os.environ['AWS_REGION'] = 'us-east-1'
            os.environ['BOTCUBE_USER_MEMORY_ROLE_ARN'] = 'arn:aws:iam::123456789012:role/user-memory'

            import socket
            from datetime import UTC, datetime, timedelta
            import boto3
            import uvicorn
            from botocore import UNSIGNED
            from botocore.stub import Stubber
            from botcube_cartridge import HarnessDefinition
            from botcube_harness_deepagents import serving
            from botcube_harness_deepagents.memory import agentcore

            def forbidden(*args, **kwargs):
                raise AssertionError('Bootstrap must not access an account or the network')

            socket.socket.connect = forbidden
            serving.configure_harness_definition(HarnessDefinition(
                skills=[], agent_name='bootstrap-test', system_prompt='',
                prepare_invocation=forbidden, prepare_root=forbidden,
                build_shell_env=forbidden,
                session_id_env_var='TEST_SESSION_ID', environment_cache_key=forbidden,
            ))
            building = boto3.client
            ready = False
            clients = []
            stubs = []

            def client(service, **options):
                if service != 'sts':
                    return building(service, **options)
                assert not ready, 'STS client constructed on the first Turn after readiness'
                assert options['region_name'] == 'us-east-1'
                assert options['config'].signature_version == UNSIGNED
                made = building(service, **options)
                clients.append(made)
                stub = Stubber(made)
                for token, run in [('first-token', 'first'), ('second-token', 'second')]:
                    stub.add_response('assume_role_with_web_identity', {'Credentials': {
                        'AccessKeyId': 'ASIA000000000000', 'SecretAccessKey': 's' * 40,
                        'SessionToken': 'session-token', 'Expiration': datetime.now(UTC) + timedelta(hours=1),
                    }}, {
                        'RoleArn': agentcore.USER_MEMORY_ROLE_ARN,
                        'RoleSessionName': 'turn-' + run, 'WebIdentityToken': token,
                    })
                stub.activate()
                stubs.append(stub)
                return made

            boto3.client = client

            def serve(app, **options):
                global ready
                ready = True
                for token, run in [('first-token', 'first'), ('second-token', 'second')]:
                    credentials, expiration = agentcore._turn_credentials(token, region_name='us-east-1', run_id=run)
                    assert credentials.method == 'explicit'
                    assert expiration > datetime.now(UTC)
                assert len(clients) == 1
                for stub in stubs:
                    stub.assert_no_pending_responses()
                print('Memory exchanges use the prepared unsigned client and each current JWT')

            uvicorn.run = serve
            serving.main()
        ''')],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == 'Memory exchanges use the prepared unsigned client and each current JWT'
