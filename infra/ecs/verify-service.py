from __future__ import annotations

import argparse
import hashlib
import http.client
import http.cookiejar
import json
import os
import runpy
import signal
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from datetime import UTC, datetime
from itertools import pairwise
from pathlib import Path
from types import FrameType
from typing import TYPE_CHECKING, Any, TypeVar

import boto3
from botocore.exceptions import ClientError

if TYPE_CHECKING:
    from types_boto3_bedrock_agentcore import BedrockAgentCoreClient
    from types_boto3_bedrock_agentcore_control import BedrockAgentCoreControlClient
    from types_boto3_ecs import ECSClient
    from types_boto3_elbv2 import ElasticLoadBalancingv2Client
    from types_boto3_elbv2.type_defs import TargetHealthDescriptionTypeDef
    from types_boto3_lambda import LambdaClient

DEPLOY_ROOT = Path(os.environ['CARTRIDGE_DEPLOY_ROOT']).resolve()
IDENTITY = json.loads((DEPLOY_ROOT / 'identity.json').read_text())
DOMAIN = 'chatServicePreview'


T = TypeVar('T')


def require(condition: object, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def required(value: T | None, name: str) -> T:
    """A provider field that a verdict or its evidence reads; absent, it fails loud (ADR 0030)."""
    if value is None:
        raise RuntimeError(f'AWS response lacks {name}')
    return value


def target_endpoint(target: TargetHealthDescriptionTypeDef) -> tuple[str, int]:
    endpoint = required(target.get('Target'), 'target Target')
    return endpoint['Id'], required(endpoint.get('Port'), 'target Port')


def target_state(target: TargetHealthDescriptionTypeDef) -> str:
    return required(required(target.get('TargetHealth'), 'target TargetHealth').get('State'), 'target TargetHealth State')


@contextmanager
def probe_deadline(seconds: float) -> Iterator[None]:
    # The acceptance CLI runs on the main thread on Linux/macOS. A socket's
    # read timeout alone does not bound a peer that keeps sending partial lines.
    def expired(_signum: int, _frame: FrameType | None) -> None:
        raise RuntimeError('Agent stream exceeded the probe deadline')
    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def deployment_ready(response: Mapping[str, Any], expected_revision: str) -> bool:
    require(not response.get('failures'), 'ECS service lookup failed')
    require(len(response['services']) == 1, 'Expected exactly one preview service')
    service = response['services'][0]
    require(service['taskDefinition'] == expected_revision, 'ECS rolled back or changed the requested task revision')
    deployments = service['deployments']
    require(not any(d.get('rolloutState') == 'FAILED' for d in deployments), 'ECS deployment failed')
    return (len(deployments) == 1 and deployments[0].get('rolloutState') == 'COMPLETED'
            and service['desiredCount'] == service['runningCount'] == 1 and service['pendingCount'] == 0)


def verify_deployment(outputs: dict[str, str], ecs: ECSClient, elb: ElasticLoadBalancingv2Client) -> dict[str, Any]:
    cluster, service, revision = outputs['ClusterName'], outputs['ServiceName'], outputs['TaskDefinitionArn']
    deadline = time.monotonic() + 900
    while not deployment_ready(ecs.describe_services(cluster=cluster, services=[service]), revision):
        require(time.monotonic() < deadline, 'Preview service stabilization timed out')
        time.sleep(15)
    task_arns = ecs.list_tasks(cluster=cluster, serviceName=service, desiredStatus='RUNNING')['taskArns']
    require(len(task_arns) == 1, 'Expected one running preview task')
    response = ecs.describe_tasks(cluster=cluster, tasks=task_arns)
    require(not response.get('failures'), 'ECS task lookup failed')
    require(len(response['tasks']) == 1, 'Expected one described preview task')
    task = response['tasks'][0]
    require(task.get('taskDefinitionArn') == revision and task.get('lastStatus') == 'RUNNING', 'Running task differs from requested revision')
    containers = required(task.get('containers'), 'ECS task containers')
    require(len(containers) == 1 and containers[0].get('imageDigest', '').startswith('sha256:'), 'Running immutable image digest is missing')
    network = required(containers[0].get('networkInterfaces'), 'container networkInterfaces')
    require(len(network) == 1, 'Preview task network interface missing')
    ec2 = boto3.client('ec2')
    # Attachment details contain the EC2 ENI id; container attachmentId is an ECS id.
    details = {required(d.get('name'), 'attachment detail name'): required(d.get('value'), 'attachment detail value')
               for a in required(task.get('attachments'), 'ECS task attachments')
               if a.get('type') == 'ElasticNetworkInterface' for d in required(a.get('details'), 'attachment details')}
    eni_id = required(details.get('networkInterfaceId'), 'ENI attachment networkInterfaceId')
    eni = ec2.describe_network_interfaces(NetworkInterfaceIds=[eni_id])['NetworkInterfaces'][0]
    require(not eni.get('Association', {}).get('PublicIp'), 'Preview task unexpectedly has a public IP')
    subnet, private_ip = required(eni.get('SubnetId'), 'network interface SubnetId'), required(eni.get('PrivateIpAddress'), 'network interface PrivateIpAddress')
    require(subnet in {s['id'] for s in IDENTITY['aws']['agentCore']['privateNatBrowser']['subnets']}, 'Preview task is outside configured private subnets')
    targets = elb.describe_target_health(TargetGroupArn=outputs['TargetGroupArn'])['TargetHealthDescriptions']
    current = [target for target in targets if target_endpoint(target) == (private_ip, 8123)]
    # ALB can continue displaying an old target as draining after deregistration.
    # Acceptance belongs to the exact running revision's ENI, never an old target.
    require(len(current) == 1 and target_state(current[0]) == 'healthy', 'Preview target is not healthy')
    return {'taskDefinitionArn': revision, 'taskArn': required(task.get('taskArn'), 'ECS task taskArn'),
            'imageDigest': required(containers[0].get('imageDigest'), 'container imageDigest'),
            'image': required(containers[0].get('image'), 'container image'), 'subnetId': subnet, 'publicIp': False,
            'stabilized': True, 'targetHealthy': True}


def request(client: urllib.request.OpenerDirector, path: str, *, method: str = 'GET',
            headers: dict[str, str] | None = None) -> tuple[int, Any]:
    req = urllib.request.Request(IDENTITY['domains'][DOMAIN] + path,
                                 method=method, headers={'User-Agent': IDENTITY['verification']['userAgent'], 'Cache-Control': 'no-cache', **(headers or {})})
    try:
        with client.open(req, timeout=30) as response:
            return response.status, None if response.status == 204 else json.load(response)
    except urllib.error.HTTPError as error:
        with error:
            return error.code, None



def parse_event(data: list[str]) -> dict[str, Any]:
    event = json.loads('\n'.join(data))
    require(isinstance(event, dict) and isinstance(event.get('type'), str), 'Malformed agent event')
    require(event['type'] != 'RUN_ERROR', 'Agent stream reported RUN_ERROR')
    return event


class StreamTiming:
    """Timing and completed tool-progress evidence of one agent stream."""

    def __init__(self, timing: dict[str, Any], observation_seconds: float, progress_rounds: int,
                 on_progress: Callable[[], object] | None) -> None:
        self.timing, self.observation_seconds, self.progress_rounds = timing, observation_seconds, progress_rounds
        self.on_progress = on_progress
        self.started = self.previous = timing['requestStarted']
        self.event_times: list[float] = []
        self.progress_times: list[float] = []
        self.calls: dict[str | None, dict[str, Any]] = {}
        timing.update({'requiredObservationSeconds': observation_seconds,
                       'requiredProgressRounds': progress_rounds if observation_seconds else 0,
                       'eventOffsetsSeconds': self.event_times, 'progressOffsetsSeconds': self.progress_times})

    def check_alive(self):
        if not self.observation_seconds:
            return
        now = time.monotonic()
        require(now - self.previous <= 60, 'Agent stream exceeded the 60-second event gap')
        require(now - self.started <= 900, 'Agent stream exceeded the 900-second probe deadline')

    def record(self, event: dict[str, Any], now: float) -> None:
        gap = now - self.previous
        self.timing['maxEventGapSeconds'] = max(self.timing.get('maxEventGapSeconds', 0), gap)
        require(not self.observation_seconds or gap <= 60, 'Agent stream exceeded the 60-second event gap')
        require(now - self.started <= 900, 'Agent stream exceeded the 900-second probe deadline')
        self.event_times.append(now - self.started)
        self.previous = now
        if event['type'] == 'RUN_FINISHED':
            self.timing['terminalSeconds'] = now - self.started
        call_id = event.get('toolCallId')
        if event['type'] == 'TOOL_CALL_START' and event.get('toolCallName') == 'execute':
            require(call_id not in self.calls, 'Repeated probe tool call identity')
            self.calls[call_id] = {'args': '', 'completed': False}
        elif event['type'] == 'TOOL_CALL_ARGS' and call_id in self.calls:
            self.calls[call_id]['args'] += event['delta']
        elif event['type'] == 'TOOL_CALL_RESULT' and call_id in self.calls:
            self.complete_tool_call(self.calls[call_id], event, now)

    def complete_tool_call(self, call: dict[str, Any], event: dict[str, Any], now: float) -> None:
        require(not call['completed'], 'Repeated probe tool result')
        call['completed'] = True
        if self.observation_seconds:
            ACCEPTANCE['verify_tool_result'](call, event)
        self.progress_times.append(now - self.started)
        if self.on_progress is not None:
            self.on_progress()

    def close(self):
        timing, event_times, progress_times = self.timing, self.event_times, self.progress_times
        closed = time.monotonic()
        timing['maxEventGapSeconds'] = max(timing.get('maxEventGapSeconds', 0), closed - self.previous)
        timing.pop('requestStarted')
        timing.update({'requiredObservationSeconds': self.observation_seconds,
                       'firstEventSeconds': event_times[0] if event_times else None,
                       'lastEventSeconds': event_times[-1] if event_times else None,
                       'connectionClosedSeconds': closed - self.started,
                       'eventOffsetsSeconds': event_times,
                       'progressCount': len(progress_times),
                       'progressOffsetsSeconds': progress_times,
                       'progressSpanSeconds': progress_times[-1] - progress_times[0] if len(progress_times) >= 2 else 0})
        if self.observation_seconds:
            self.require_observed_progress()

    def require_observed_progress(self):
        timing, progress_times = self.timing, self.progress_times
        require(timing['maxEventGapSeconds'] <= 60, 'Agent stream exceeded the 60-second event gap')
        require(len(progress_times) >= 2, 'Agent stream lacks completed tool progress')
        require(len(progress_times) == self.progress_rounds, 'Agent completed an unexpected number of probe rounds')
        require(timing['progressSpanSeconds'] >= self.observation_seconds, 'Agent tool progress ended before the required observation interval')
        progress_boundaries = [0, *progress_times, timing['connectionClosedSeconds']]
        timing['maxProgressGapSeconds'] = max(b - a for a, b in pairwise(progress_boundaries))
        require(timing['maxProgressGapSeconds'] <= 60, 'Agent stream exceeded the 60-second tool progress gap')


def read_events(response: http.client.HTTPResponse, *, timing: dict[str, Any] | None = None, observation_seconds: float = 0,
                progress_rounds: int = 120, on_progress: Callable[[], object] | None = None) -> list[dict[str, Any]]:
    require(response.status == 200, 'Agent invocation did not return HTTP 200')
    require(response.headers.get_content_type() == 'text/event-stream', 'Agent response is not SSE')
    stream = StreamTiming(timing, observation_seconds, progress_rounds, on_progress) if timing is not None else None
    events, data = [], []
    for raw in response:
        if stream is not None:
            stream.check_alive()
        line = raw.decode('utf-8').rstrip('\r\n')
        if line.startswith('data:'):
            data.append(line[5:].lstrip(' '))
        elif not line and data:
            event = parse_event(data)
            if stream is not None:
                stream.record(event, time.monotonic())
            events.append(event)
            data = []
    require(not data, 'Agent stream ended with an incomplete SSE frame')
    if stream is not None:
        stream.close()
    return events


def verify_answer(events: list[dict[str, Any]], thread_id: str, run_id: str, expected: str) -> str:
    starts = [e for e in events if e['type'] == 'RUN_STARTED']
    finishes = [e for e in events if e['type'] == 'RUN_FINISHED']
    require(len(starts) == len(finishes) == 1, 'Agent stream lacks one complete successful run')
    require(events[-1] == finishes[0], 'Agent stream has events after terminal success')
    require(all(e.get('threadId') == thread_id and e.get('runId') == run_id for e in starts + finishes), 'Agent run identity differs from request')
    messages = {}
    ended = set()
    for event in events:
        kind, message_id = event['type'], event.get('messageId')
        if kind == 'TEXT_MESSAGE_START' and event.get('role') == 'assistant':
            require(message_id not in messages, 'Repeated assistant message identity')
            messages[message_id] = ''
        elif kind == 'TEXT_MESSAGE_CONTENT':
            require(message_id in messages and message_id not in ended, 'Text delta lacks an open assistant message')
            messages[message_id] += event['delta']
        elif kind == 'TEXT_MESSAGE_END':
            require(message_id in messages, 'Text end lacks an assistant message')
            ended.add(message_id)
    final_message = next(reversed(messages), None)
    require(final_message in ended and messages[final_message].strip() == expected, 'Agent did not complete the requested answer')
    return expected



class SessionRecord:
    """The deployed AgentCore Memory holding each Session's events (ADR 0067)."""

    def __init__(self, control: BedrockAgentCoreControlClient, data: BedrockAgentCoreClient) -> None:
        name = IDENTITY['aws']['agentCore']['memory']
        memories: list[str] = []
        args: dict[str, Any] = {}
        while True:
            page = control.list_memories(**args)
            ids = [required(memory.get('id'), 'AgentCore memory id') for memory in page['memories']]
            memories.extend(memory_id for memory_id in ids if memory_id.startswith(name + '-'))
            token = page.get('nextToken')
            if not token:
                break
            args['nextToken'] = token
        require(len(memories) == 1, 'Expected exactly one deployed AgentCore memory')
        self.memory_id, self.control, self.data = memories[0], control, data

    def expiry_days(self):
        return self.control.get_memory(memoryId=self.memory_id)['memory']['eventExpiryDuration']

    def has_events(self, actor_id: str, session_id: str) -> bool:
        return bool(self.data.list_events(memoryId=self.memory_id, actorId=actor_id, sessionId=session_id,
                                          includePayloads=False, maxResults=1)['events'])

    def writes_sessions(self, actor_id: str, session_id: str) -> list[str]:
        # The snapshot checkpointer files pending writes in `lgw-<sha256(Session)[:32]>-*` sessions.
        prefix = 'lgw-' + hashlib.sha256(session_id.encode()).hexdigest()[:32] + '-'
        sessions: list[str] = []
        args: dict[str, Any] = {}
        while True:
            page = self.data.list_sessions(memoryId=self.memory_id, actorId=actor_id, **args)
            sessions.extend(summary['sessionId'] for summary in page['sessionSummaries'] if summary['sessionId'].startswith(prefix))
            token = page.get('nextToken')
            if not token:
                return sessions
            args['nextToken'] = token

    def wait_purged(self, actor_id: str, session_id: str, seconds: float = 300) -> None:
        # The purge runs in the background at AgentCore's per-Session delete rate.
        deadline = time.monotonic() + seconds
        while any(self.has_events(actor_id, session) for session in [session_id, *self.writes_sessions(actor_id, session_id)]):
            require(time.monotonic() < deadline, 'Deleted Session events were not purged')
            time.sleep(5)


def verify_session_api(record: SessionRecord, lambda_client: LambdaClient) -> dict[str, Any]:
    require(record.expiry_days() == 365, 'AgentCore Memory event expiry is not 365 days')
    aws = IDENTITY['aws']
    function_arn = f"arn:aws:lambda:{aws['region']}:{aws['account']}:function:{aws['agentCore']['sessionApiFunction']}"
    probe = {'operation': 'get', 'sessionId': 'deploy-verification-' + uuid.uuid4().hex, 'userId': 'deploy-verification'}
    try:
        lambda_client.invoke(FunctionName=function_arn, Payload=json.dumps(probe).encode())
    except ClientError as error:
        require(error.response.get('Error', {}).get('Code') == 'AccessDeniedException', 'Session API rejected the deploy role for another reason')
    else:
        raise RuntimeError('The session API accepted a caller other than the Chat Service role')
    return {'eventExpiryDays': 365, 'foreignCallerRejected': True}



def stream_conversation(client: urllib.request.OpenerDirector, req: urllib.request.Request, timing: dict[str, Any],
                        observation_seconds: float, progress_rounds: int,
                        on_progress: Callable[[], object] | None) -> list[dict[str, Any]]:
    try:
        timing['requestStartedAt'] = datetime.now(UTC).isoformat()
        timing['requestStarted'] = time.monotonic()
        timing['requestMonotonicSeconds'] = timing['requestStarted']
        with probe_deadline(900), client.open(req, timeout=60 if observation_seconds else 180) as response:
            timing['connectedSeconds'] = time.monotonic() - timing['requestStarted']
            return read_events(response, timing=timing, observation_seconds=observation_seconds, progress_rounds=progress_rounds, on_progress=on_progress)
    except urllib.error.HTTPError as error:
        with error:
            raise RuntimeError(f'Agent invocation failed with HTTP {error.code}') from None
    except (OSError, EOFError):
        raise RuntimeError('Agent stream connection failed or was interrupted') from None


def require_invalid_invocation_rejected(client: urllib.request.OpenerDirector, headers: dict[str, str]) -> None:
    invalid = urllib.request.Request(IDENTITY['domains'][DOMAIN] + '/', data=b'{}', headers=headers)
    try:
        with client.open(invalid, timeout=30):
            raise RuntimeError('Malformed invocation unexpectedly succeeded')
    except urllib.error.HTTPError as error:
        with error:
            require(error.code == 422, 'Malformed invocation was not rejected by request validation')



def verify_conversation(*, observation_seconds: float = 0, progress_rounds: int = 120, timing: dict[str, Any] | None = None,
                        on_progress: Callable[[], object] | None = None, before_replay: Callable[[], object] | None = None,
                        settle: Callable[[], object] | None = None, session_record: SessionRecord | None = None) -> dict[str, Any]:
    timing = {} if timing is None else timing
    owner_client, owner = ACCEPTANCE['conversation_owner_client']()
    other_client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    status, other = request(other_client, '/account/session')
    require(status == 200 and ACCEPTANCE['is_other_account'](other, owner),
            'Conversation isolation client creation failed')
    clients = [owner_client, other_client]
    thread_id, run_id = str(uuid.uuid4()), str(uuid.uuid4())
    expected = 'preview acceptance ' + uuid.uuid4().hex
    prompt = ACCEPTANCE['conversation_prompt'](expected, observation_seconds, progress_rounds)
    payload = {'threadId': thread_id, 'runId': run_id,
               'messages': [{'id': str(uuid.uuid4()), 'role': 'user', 'content': prompt}],
               'tools': [], 'context': [], 'state': {}, 'forwardedProps': {'model': ACCEPTANCE['MODEL']}}
    headers = {'User-Agent': IDENTITY['verification']['userAgent'], 'Content-Type': 'application/json', 'Accept': 'text/event-stream'}
    try:
        req = urllib.request.Request(IDENTITY['domains'][DOMAIN] + '/', data=json.dumps(payload).encode(), headers=headers)
        events = stream_conversation(clients[0], req, timing, observation_seconds, progress_rounds, on_progress)
        verify_answer(events, thread_id, run_id, expected)
        if before_replay is not None:
            before_replay()
        timing['replayStartedAt'] = datetime.now(UTC).isoformat()
        status, history = request(clients[0], '/threads')
        require(status == 200, 'Conversation history failed')
        listed = [thread for thread in history['threads'] if thread['id'] == thread_id]
        require(len(listed) == 1, 'Conversation history does not list the conversation')
        # Replay reads the Session record through the deployed session API.
        status, replay = request(clients[0], '/threads/' + thread_id)
        require(status == 200 and any(message['role'] == 'assistant' and message['content'].strip() == expected for message in replay['messages']), 'Persisted history did not replay the complete answer')
        if session_record is not None:
            require(session_record.has_events(ACCEPTANCE['filing_user_id'](owner), thread_id), 'The Session record is not filed under its owner and Session ID')
        status, other = request(clients[1], '/threads')
        require(status == 200 and all(thread['id'] != thread_id for thread in other['threads']), 'Another anonymous owner can read the conversation')
        status, _ = request(clients[1], '/threads/' + thread_id)
        require(status == 404, 'Another anonymous owner can read the conversation')
        status, _ = request(clients[1], '/threads/' + thread_id, method='DELETE')
        require(status == 204, 'Foreign-owner deletion probe returned an unexpected status')
        status, retained = request(clients[0], '/threads')
        require(status == 200 and listed[0] in retained['threads'], 'Another anonymous owner deleted or changed the conversation')
        require_invalid_invocation_rejected(clients[0], headers)
        return {'completeAnswer': True, 'terminalSuccess': True, 'historyReplay': True,
                'isolated': True, 'foreignDeleteRejected': True, 'invalidInvocationRejected': True,
                'threadId': thread_id, 'runId': run_id, 'eventCount': len(events),
                'timing': timing}
    finally:
        timing.pop('requestStarted', None)
        try:
            if settle is not None:
                settle()
        finally:
            cleanup_conversation(clients[0], thread_id, timing)
            if session_record is not None:
                session_record.wait_purged(ACCEPTANCE['filing_user_id'](owner), thread_id)
                timing['sessionRecordPurged'] = True

def cleanup_conversation(client: urllib.request.OpenerDirector, thread_id: str, timing: dict[str, Any]) -> None:
    status, _ = request(client, '/threads/' + thread_id, method='DELETE')
    require(status == 204, 'Test conversation cleanup failed')
    status, history = request(client, '/threads')
    require(status == 200 and all(thread['id'] != thread_id for thread in history['threads']), 'Deleted test conversation remains in history')
    status, _ = request(client, '/threads/' + thread_id)
    require(status == 404, 'Deleted test conversation still replays')
    timing['conversationDeleted'] = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('outputs')
    parser.add_argument('--replacement-evidence', type=Path)
    parser.add_argument('--observation-seconds', type=int, choices=range(601), default=0, metavar='0..600')
    parser.add_argument('--progress-rounds', type=int, choices=range(2, 121), default=120, metavar='2..120')
    args = parser.parse_args()
    outputs = json.loads(Path(args.outputs).read_text())[IDENTITY['aws']['ecs']['previewOriginStackName']]
    deployment = verify_deployment(outputs, boto3.client('ecs'), boto3.client('elbv2'))
    if args.replacement_evidence:
        replacement = json.loads(args.replacement_evidence.read_text())
        require(replacement['completed'] and replacement['sourceRevision'] == os.environ['GITHUB_SHA']
                and replacement['workflowRun'] == os.environ['GITHUB_RUN_ID']
                and replacement['workflowAttempt'] == os.environ['GITHUB_RUN_ATTEMPT'], 'Replacement evidence belongs to another run')
        require(all(deployment[key] == replacement['newTask'][key] for key in ('taskArn', 'taskDefinitionArn', 'imageDigest')),
                'Conversation target differs from proven replacement')
    table = boto3.resource('dynamodb').Table(outputs['ChatTableName'])
    sessions = ACCEPTANCE['verify_sessions'](table)
    record = SessionRecord(boto3.client('bedrock-agentcore-control'), boto3.client('bedrock-agentcore'))
    timing = {}
    evidence = {'revision': os.environ['GITHUB_SHA'], 'verifiedAt': datetime.now(UTC).isoformat(), 'deployment': deployment, 'sessions': sessions,
                'conversation': {'timing': timing}, 'status': 'failed', 'workflowRunId': os.environ['GITHUB_RUN_ID']}
    try:
        evidence['sessionApi'] = verify_session_api(record, boto3.client('lambda'))
        evidence['conversation'] = verify_conversation(observation_seconds=args.observation_seconds, progress_rounds=args.progress_rounds, timing=timing, session_record=record)
        if args.replacement_evidence:
            after = verify_deployment(outputs, boto3.client('ecs'), boto3.client('elbv2'))
            require(after == deployment, 'Task changed during replacement conversation acceptance')
        evidence['status'] = 'passed'
    finally:
        Path(os.environ['RUNNER_TEMP'], 'preview-service-evidence.json').write_text(json.dumps(evidence, indent=2))
        print(json.dumps(evidence), flush=True)


ACCEPTANCE = runpy.run_path(str(DEPLOY_ROOT / IDENTITY['verification']['acceptanceHook']), init_globals=globals())

if __name__ == '__main__':
    main()
