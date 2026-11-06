import json
import subprocess
import sys
import textwrap
from uuid import UUID

import pytest

# Runs a real subprocess, server or socket (ADR 0083 decision 1).
pytestmark = pytest.mark.integration


@pytest.mark.parametrize('run_main', [True, False])
def test_process_observations_join_handoff_health_and_first_handler_without_payloads(run_main: bool) -> None:
    program = textwrap.dedent('''
        import asyncio
        import json
        import logging
        import socket
        import sys

        attempts = []
        def forbidden(*args, **kwargs):
            attempts.append('blocked')
            raise AssertionError('Readiness diagnostic must not use network or account hooks')

        socket.socket.connect = forbidden
        socket.getaddrinfo = forbidden
        import httpx
        import uvicorn
        from botcube_cartridge import HarnessDefinition
        from botcube_harness_deepagents import serving
        from opentelemetry import trace
        from opentelemetry.trace import NonRecordingSpan, SpanContext, TraceFlags

        serving.configure_harness_definition(HarnessDefinition(
            skills=[], agent_name='diagnostic-fixture', system_prompt='',
            prepare_invocation=forbidden, prepare_root=forbidden, build_shell_env=forbidden,
            session_id_env_var='TEST_SESSION_ID', environment_cache_key=forbidden,
        ))
        logging.basicConfig(level=logging.INFO, format='%(message)s')

        async def requests():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=serving.app), base_url='http://fixture.invalid') as client:
                if sys.argv[1] == 'main':
                    pings = await asyncio.gather(client.get('/ping'), client.get('/ping'))
                    assert [r.status_code for r in pings] == [200, 200]
                    assert all(r.json() == {'status': 'Healthy'} for r in pings)
                context = SpanContext(trace_id=0x1234, span_id=0x5678, is_remote=False, trace_flags=TraceFlags(1))
                with trace.use_span(NonRecordingSpan(context)):
                    first = await client.post('/invocations', content='private-payload-canary', headers={'Authorization': 'Bearer private-credential-canary', 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': 'runtime-session-canary'})
                    second = await client.post('/invocations', content='private-payload-canary')
                assert first.status_code == second.status_code == 400
                assert not attempts
                print(json.dumps({'httpUnchanged': True, 'networkAttempts': len(attempts)}))

        if sys.argv[1] == 'main':
            uvicorn.run = lambda app, **options: asyncio.run(requests())
            serving.main()
        else:
            asyncio.run(requests())
    ''')
    result = subprocess.run([sys.executable, '-c', program, 'main' if run_main else 'direct'], capture_output=True, text=True, timeout=30, check=False)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {'httpUnchanged': True, 'networkAttempts': 0}
    records = [json.loads(line) for line in result.stderr.splitlines() if line.startswith('{')]
    records = [record for record in records if record.get('event') == 'harness_process_observation']
    assert [record['stage'] for record in records] == (['serve_handoff', 'first_ping', 'first_asgi_invocation', 'first_invocation'] if run_main else ['first_asgi_invocation', 'first_invocation'])
    # Only an invocation names the process: on Runtime V2 the records before it come from the snapshot.
    invocations = [record for record in records if record['stage'] in ('first_asgi_invocation', 'first_invocation')]
    assert len({record['processId'] for record in invocations}) == 1
    # The microVM's runtime session: a warmup and its Turn share one VM only under one runtime session ID.
    assert [record['runtimeSessionId'] for record in invocations] == ['runtime-session-canary'] * 2
    assert all(record['processId'] is None for record in records if record not in invocations)
    assert UUID(records[-1]['processId']).version == 4
    final = records[-1]
    assert final['traceId'] == '00000000000000000000000000001234'
    assert final['spanId'] == '0000000000005678'
    assert set(final) == {'event', 'stage', 'processId', 'atUnixNs', 'handoffAtUnixNs', 'firstPingAtUnixNs', 'sinceHandoffMs', 'sinceFirstPingMs', 'traceId', 'spanId', 'ingressAtUnixNs', 'sinceIngressMs', 'runtimeSessionId'}
    if run_main:
        assert final['handoffAtUnixNs'] == records[0]['atUnixNs']
        assert final['firstPingAtUnixNs'] == records[1]['atUnixNs']
        assert final['sinceHandoffMs'] >= 0
        assert final['sinceFirstPingMs'] >= 0
    else:
        assert final['handoffAtUnixNs'] is None
        assert final['firstPingAtUnixNs'] is None
        assert final['sinceHandoffMs'] is None
        assert final['sinceFirstPingMs'] is None
    assert 'private-payload-canary' not in json.dumps(records)
    assert 'private-credential-canary' not in json.dumps(records)


def test_first_invocation_records_ingress_before_fastapi_instrumentation() -> None:
    program = textwrap.dedent("""
        import asyncio
        import json
        import logging
        import httpx
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from botcube_harness_deepagents import serving

        records = []
        hooks = []
        class Capture(logging.Handler):
            def emit(self, record):
                records.append(json.loads(record.getMessage()))
        logger = logging.getLogger('botcube_harness_deepagents.process_observation')
        logger.setLevel(logging.INFO)
        logger.addHandler(Capture())
        trace.set_tracer_provider(TracerProvider())

        def hook(span, scope):
            ingress = next((r for r in records if r['stage'] == 'first_asgi_invocation'), None)
            hooks.append((ingress, span.start_time))

        FastAPIInstrumentor.instrument_app(serving.app, excluded_urls='/ping', server_request_hook=hook)
        async def requests():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=serving.app), base_url='http://fixture.invalid') as client:
                assert (await client.get('/ping')).json() == {'status': 'Healthy'}
                for _ in range(2):
                    response = await client.post('/invocations', content='private-body-canary', headers={'Authorization': 'Bearer private-auth-canary'})
                    assert response.status_code == 400
            assert len(hooks) == 2
            ingress, span_start = hooks[0]
            assert ingress is not None, 'Missing ingress observation before the OTel server span'
            assert ingress['atUnixNs'] <= span_start
            assert sum(r['stage'] == 'first_asgi_invocation' for r in records) == 1
            invocation = next(r for r in records if r['stage'] == 'first_invocation')
            assert invocation['ingressAtUnixNs'] == ingress['atUnixNs']
            assert invocation['sinceIngressMs'] >= 0
            assert 'private-body-canary' not in json.dumps(records)
            assert 'private-auth-canary' not in json.dumps(records)
            print('ingress precedes instrumentation; HTTP and payload privacy preserved')
        asyncio.run(requests())
    """)
    result = subprocess.run([sys.executable, '-c', program], capture_output=True, text=True, timeout=30, check=False)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == 'ingress precedes instrumentation; HTTP and payload privacy preserved'
