"""One real invocation across replacement; run only under the preview-origin owner."""
import json
import os
import runpy
import sys
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import UTC, datetime
from itertools import pairwise
from pathlib import Path
from typing import Any

import boto3
from botocore.config import Config

HERE = Path(__file__).resolve().parent
service = runpy.run_path(str(HERE / 'verify-service.py'))
replacement = runpy.run_path(str(HERE / 'verify-replacement.py'))
require = service['require']


def verify_overlap(report: dict[str, Any], timing: dict[str, Any]) -> None:
    require(report.get('completed'), 'Requested replacement did not complete')
    origin = timing['requestMonotonicSeconds']
    progress = [origin + offset for offset in timing['progressOffsetsSeconds']]
    require(progress and progress[0] < report['requestedMonotonicSeconds'],
            'Replacement lacks successful prior tool progress')
    observations = report['observations']
    # Bracket a received successful result with two observations of draining.
    # Use the end of the first read and start of the next, not queued callbacks.
    during = [point for point in progress if any(
        left['oldTargetState'] == right['oldTargetState'] == 'draining'
        and left['observedMonotonicSeconds'] < point < right['targetReadMonotonicSeconds']
        for left, right in pairwise(observations))]
    require(during, 'No real tool progress bracketed by old-target draining observations')
    terminal = origin + timing['terminalSeconds']
    require(terminal > during[-1], 'Stream finished before draining progress')
    # Request time is a conservative lower bound for deregistration initiation.
    remaining = origin + timing['connectionClosedSeconds'] - report['requestedMonotonicSeconds']
    require(0 < remaining < report['deregistrationDelaySeconds'], 'Drain setting does not cover the measured remaining stream')
    require(max(60, timing['maxEventGapSeconds']) < report['idleTimeoutSeconds'],
            'ALB idle timeout does not exceed accepted event gap')
    report['continuity'] = {'progressDuringDraining': len(during),
        'progressDuringDrainingMonotonicSeconds': during, 'terminalMonotonicSeconds': terminal,
        'requestToStreamCloseSeconds': remaining, 'sameInvocation': True}


class Continuity:
    def __init__(self, outputs: dict[str, str], old: dict[str, Any], report: dict[str, Any],
                 pool: ThreadPoolExecutor) -> None:
        self.outputs, self.old, self.report, self.pool = outputs, old, report, pool
        self.future: Future[None] | None = None

    def progress(self):
        if self.future is None:
            self.future = self.pool.submit(self.replace)
        elif self.future.done():
            self.future.result()  # Worker failures must fail the conversation too.

    def replace(self):
        # Boto3 sessions are not shared with the SSE reader thread.
        session = boto3.Session()
        config = Config(connect_timeout=10, read_timeout=20, retries={'total_max_attempts': 1})
        replacement['exercise'](self.outputs, session.client('ecs', config=config),
                                session.client('elbv2', config=config), self.report, expected_old=self.old)

    def settle(self):
        if self.future is not None:
            self.future.result()

    def before_replay(self, timing: dict[str, Any]) -> None:
        require(self.future is not None, 'Stream ended before replacement was triggered')
        self.settle()
        verify_overlap(self.report, timing)
        after = service['verify_deployment'](self.outputs, boto3.client('ecs'), boto3.client('elbv2'))
        require(all(after[key] == self.report['newTask'][key] for key in ('taskArn', 'taskDefinitionArn', 'imageDigest')),
                'Replay target differs from the requested replacement')
        self.report['postDeployment'] = after


def main():
    outputs = json.loads(Path(sys.argv[1]).read_text())[service['IDENTITY']['aws']['ecs']['previewOriginStackName']]
    report = {'sourceRevision': os.environ['GITHUB_SHA'], 'workflowRun': os.environ['GITHUB_RUN_ID'],
              'workflowAttempt': os.environ['GITHUB_RUN_ATTEMPT'], 'completed': False}
    timing = {}
    evidence = {'revision': os.environ['GITHUB_SHA'], 'workflowRunId': os.environ['GITHUB_RUN_ID'],
                'conversation': {'timing': timing}, 'status': 'failed'}
    try:
        ecs, elb = boto3.client('ecs'), boto3.client('elbv2')
        deployment = service['verify_deployment'](outputs, ecs, elb)
        table = boto3.resource('dynamodb').Table(outputs['ChatTableName'])
        evidence.update(deployment=deployment, sessions=service['ACCEPTANCE']['verify_sessions'](table))
        response = ecs.describe_tasks(cluster=outputs['ClusterName'], tasks=[deployment['taskArn']])
        require(not response.get('failures') and len(response['tasks']) == 1, 'Initial task lookup failed')
        old = replacement['task_identity'](response['tasks'][0])
        require(all(old[key] == deployment[key] for key in ('taskArn', 'taskDefinitionArn', 'imageDigest')), 'Initial task identity changed')
        targets = elb.describe_target_health(TargetGroupArn=outputs['TargetGroupArn'])['TargetHealthDescriptions']
        replacement['require_only_healthy_target'](targets, old)
        report['initialStreamTask'] = old
        report['initialTargetVerifiedAt'] = datetime.now(UTC).isoformat()
        with ThreadPoolExecutor(max_workers=1) as pool:
            probe = Continuity(outputs, old, report, pool)
            evidence['conversation'] = service['verify_conversation'](observation_seconds=180, progress_rounds=120,
                timing=timing, on_progress=probe.progress, before_replay=lambda: probe.before_replay(timing), settle=probe.settle)
        after = service['verify_deployment'](outputs, ecs, elb)
        require(after == report['postDeployment'], 'Task changed during post-deployment replay')
        require(timing['replayStartedAt'] >= report['completedAt'], 'Replay preceded deployment completion')
        evidence['status'] = 'passed'
    finally:
        report['finishedAt'] = datetime.now(UTC).isoformat()
        root = Path(os.environ['RUNNER_TEMP'])
        (root / 'preview-replacement-evidence.json').write_text(json.dumps(report, indent=2) + '\n')
        (root / 'preview-service-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
        print(json.dumps({'status': evidence['status'], 'continuity': report.get('continuity')}), flush=True)


if __name__ == '__main__':
    main()
