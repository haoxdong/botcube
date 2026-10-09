import subprocess
import sys
import textwrap


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
                execute_description='', prepare_invocation=forbidden,
                command_validator=forbidden, prepare_root=forbidden,
                build_shell_env=forbidden, shell_timeout=1, max_output_bytes=1,
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
