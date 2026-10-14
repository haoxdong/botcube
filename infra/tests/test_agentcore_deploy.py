import importlib.util
import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

spec = importlib.util.spec_from_file_location(
    'agentcore_deploy', Path(__file__).parents[1] / 'agentcore' / 'deploy.py'
)
assert spec is not None and spec.loader is not None
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)

ARN = 'arn:aws:cloudformation:us-east-1:123456789012:changeSet/reviewed/fixture'
STACK_ID = 'fixture-stack-id'
PROTECTED = {
    'Runtime': ('AWS::BedrockAgentCore::Runtime', 'runtime-fixture'),
    'Memory': ('AWS::BedrockAgentCore::Memory', 'memory-fixture'),
}
CHANGE_SET = {
    'ChangeSetId': ARN,
    'StackId': STACK_ID,
    'Status': 'CREATE_COMPLETE',
    'ExecutionStatus': 'AVAILABLE',
    'Changes': [],
}


def install_aws(
    monkeypatch: pytest.MonkeyPatch,
    change_set: dict[str, Any],
    deployed_commit: str = 'fixture-commit',
) -> list[tuple[str, ...]]:
    calls: list[tuple[str, ...]] = []

    commit_output = {'OutputKey': 'Commit', 'OutputValue': 'previous-commit'}
    responses = {
        ('cloudformation', 'list-stack-resources', '--stack-name', 'fixture-stack'): {
            'StackResourceSummaries': [
                {'LogicalResourceId': logical, 'ResourceType': kind, 'PhysicalResourceId': physical}
                for logical, (kind, physical) in PROTECTED.items()
            ],
        },
        ('cloudformation', 'describe-change-set', '--stack-name', 'fixture-stack', '--change-set-name', 'candidate'): change_set,
        ('cloudformation', 'execute-change-set', '--stack-name', 'fixture-stack', '--change-set-name', ARN): {},
        ('cloudformation', 'describe-stacks', '--stack-name', 'fixture-stack'): {
            'Stacks': [{
                'StackId': STACK_ID,
                'StackStatus': 'UPDATE_COMPLETE',
                'Outputs': [commit_output, {'OutputKey': 'AgentRuntimeVersion', 'OutputValue': '7'}],
            }],
        },
        ('bedrock-agentcore-control', 'get-agent-runtime', '--agent-runtime-id', 'runtime-fixture', '--agent-runtime-version', '7'): {
            'agentRuntimeId': 'runtime-fixture', 'agentRuntimeVersion': '7',
            'agentRuntimeArn': 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-fixture',
            'status': 'READY',
        },
        ('bedrock-agentcore-control', 'get-agent-runtime-endpoint', '--agent-runtime-id', 'runtime-fixture', '--endpoint-name', 'DEFAULT'): {
            'status': 'READY', 'liveVersion': '7',
        },
    }

    def aws(service: str, operation: str, *arguments: str) -> dict[str, Any]:
        request = (service, operation, *arguments)
        response = responses[request]
        calls.append(request)
        if operation == 'execute-change-set':
            commit_output['OutputValue'] = deployed_commit
        return response

    def wait(arguments: list[str], *, check: bool, timeout: int) -> subprocess.CompletedProcess[str]:
        assert arguments == ['aws', 'cloudformation', 'wait', 'stack-update-complete', '--stack-name', 'fixture-stack']
        assert check and timeout == 1800
        calls.append(('cloudformation', 'wait'))
        return subprocess.CompletedProcess(arguments, 0)

    monkeypatch.setattr(deployment, 'aws', aws)
    monkeypatch.setattr(deployment.subprocess, 'run', wait)
    return calls


def test_issue_4100_executes_stack_only_changes_and_verifies_updated_commit(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    calls = install_aws(monkeypatch, CHANGE_SET)
    proof = tmp_path / 'proof.json'

    deployment.deploy('fixture-stack', 'candidate', 'fixture-commit', str(proof))

    assert [call[1] for call in calls] == [
        'list-stack-resources', 'describe-change-set', 'describe-stacks',
        'execute-change-set', 'wait', 'list-stack-resources', 'describe-stacks',
        'get-agent-runtime', 'get-agent-runtime-endpoint',
    ]
    assert json.loads(proof.read_text()) == {
        'stack': 'fixture-stack', 'changeSetArn': ARN, 'executed': True,
        'commit': 'fixture-commit',
        'runtimeArn': 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-fixture',
        'runtimeVersion': '7', 'status': 'READY',
        'protectedResources': {
            'Runtime': ['AWS::BedrockAgentCore::Runtime', 'runtime-fixture'],
            'Memory': ['AWS::BedrockAgentCore::Memory', 'memory-fixture'],
        },
    }


@pytest.mark.parametrize('extra,message', [
    ({'Changes': None}, 'Missing resource changes'),
    ({'Changes': {}}, 'Missing resource changes'),
    ({'Changes': ''}, 'Missing resource changes'),
    ({'Status': 'CREATE_PENDING'}, 'Change set is not available'),
    ({'ExecutionStatus': 'UNAVAILABLE'}, 'Change set is not available'),
    ({'NextToken': 'unread'}, 'Incomplete change set'),
    ({'StackId': 'another-stack'}, 'Change set belongs to another stack'),
    ({'ChangeSetId': 'candidate'}, 'Missing change-set ARN'),
])
def test_rejects_malformed_or_unreviewable_changes_before_execution(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, extra: dict[str, Any], message: str,
) -> None:
    calls = install_aws(monkeypatch, {**CHANGE_SET, **extra})
    proof = tmp_path / 'proof.json'
    with pytest.raises(ValueError, match=message):
        deployment.deploy('fixture-stack', 'candidate', 'fixture-commit', str(proof))
    assert all(call[1] != 'execute-change-set' for call in calls)
    assert not proof.exists()


def test_rejects_missing_changes_before_execution(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls = install_aws(monkeypatch, {key: value for key, value in CHANGE_SET.items() if key != 'Changes'})
    proof = tmp_path / 'proof.json'
    with pytest.raises(KeyError, match='Changes'):
        deployment.deploy('fixture-stack', 'candidate', 'fixture-commit', str(proof))
    assert all(call[1] != 'execute-change-set' for call in calls)
    assert not proof.exists()


def test_stack_only_update_with_stale_commit_fails_without_proof(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    calls = install_aws(monkeypatch, CHANGE_SET, deployed_commit='previous-commit')
    proof = tmp_path / 'proof.json'
    with pytest.raises(ValueError, match='Deployed Commit does not match checkout'):
        deployment.deploy('fixture-stack', 'candidate', 'fixture-commit', str(proof))
    assert any(call[1] == 'execute-change-set' for call in calls)
    assert not proof.exists()
