import importlib.util
import json
import subprocess
import sys
from copy import deepcopy
from pathlib import Path

import pytest

RECOVERY_SCRIPT = Path(__file__).parents[1] / "agentcore" / "recovery.py"
spec = importlib.util.spec_from_file_location("agentcore_recovery", RECOVERY_SCRIPT)
assert spec is not None and spec.loader is not None
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


def test_detaches_only_runtime_and_restores_original_template() -> None:
    template = {
        "Resources": {
            "Runtime": {
                "Type": "AWS::BedrockAgentCore::Runtime",
                "Properties": {"AgentRuntimeName": "fixture"},
            },
            "Memory": {"Type": "AWS::BedrockAgentCore::Memory"},
            "SessionApi": {"Type": "AWS::Lambda::Function"},
            "Image": {"Type": "AWS::ECR::Repository", "DeletionPolicy": "Retain"},
        },
        "Outputs": {
            "RuntimeArn": {
                "Value": {"Fn::GetAtt": ["Runtime", "AgentRuntimeArn"]},
                "Export": {"Name": "runtime-arn"},
            },
            "MemoryId": {"Value": {"Fn::GetAtt": ["Memory", "MemoryId"]}},
            "Commit": {"Value": "deployed-commit"},
        },
    }
    before = deepcopy(template)
    phases = recovery.templates(template, {"RuntimeArn": "old-runtime-arn"})

    assert template == before
    retained = deepcopy(before)
    retained["Resources"]["Runtime"]["DeletionPolicy"] = "Retain"
    assert phases["retain"] == retained
    detached = deepcopy(retained)
    del detached["Resources"]["Runtime"]
    detached["Outputs"]["RuntimeArn"]["Value"] = "old-runtime-arn"
    assert phases["detach"] == detached
    assert phases["restore"] == before


@pytest.mark.parametrize(
    "reference",
    [
        {"Ref": "Runtime"},
        {"Fn::GetAtt": ["Runtime", "AgentRuntimeArn"]},
        {"Fn::Sub": "${Runtime.AgentRuntimeArn}"},
        {"DependsOn": ["Runtime"]},
    ],
)
def test_refuses_to_detach_a_runtime_used_by_another_resource(
    reference: dict[str, object],
) -> None:
    template = {
        "Resources": {
            "Runtime": {"Type": "AWS::BedrockAgentCore::Runtime"},
            "Consumer": {"Type": "Custom::Consumer", **reference},
        }
    }
    with pytest.raises(ValueError, match="Consumer references Runtime"):
        recovery.templates(template, {})


def test_refuses_to_freeze_an_unresolved_runtime_output() -> None:
    template = {
        "Resources": {"Runtime": {"Type": "AWS::BedrockAgentCore::Runtime"}},
        "Outputs": {
            "RuntimeArn": {"Value": {"Fn::GetAtt": ["Runtime", "AgentRuntimeArn"]}}
        },
    }
    with pytest.raises(ValueError, match="RuntimeArn"):
        recovery.templates(template, {})


@pytest.mark.parametrize("runtimes", [0, 2])
def test_requires_exactly_one_runtime(runtimes: int) -> None:
    template = {
        "Resources": {
            f"Runtime{index}": {"Type": "AWS::BedrockAgentCore::Runtime"}
            for index in range(runtimes)
        }
    }
    with pytest.raises(ValueError, match="exactly one Runtime"):
        recovery.templates(template, {})


@pytest.mark.integration
def test_prepares_archived_templates_and_previous_parameters_from_aws_snapshots(
    tmp_path: Path,
) -> None:
    template = {"Resources": {"Runtime": {"Type": "AWS::BedrockAgentCore::Runtime"}}}
    (tmp_path / "template.json").write_text(json.dumps({"TemplateBody": template}))
    stack = {
        "Stacks": [
            {
                "StackId": "fixture-stack",
                "StackStatus": "UPDATE_COMPLETE",
                "Outputs": [],
                "Parameters": [
                    {"ParameterKey": "Network", "ParameterValue": "/fixture/network"}
                ],
            }
        ]
    }
    (tmp_path / "stack.json").write_text(json.dumps(stack))
    arguments = [
        sys.executable,
        str(RECOVERY_SCRIPT),
        str(tmp_path / "template.json"),
        str(tmp_path / "stack.json"),
        str(tmp_path / "prepared"),
    ]
    subprocess.run(arguments, check=True, capture_output=True, text=True)
    assert json.loads((tmp_path / "prepared/restore.json").read_text()) == template
    assert json.loads((tmp_path / "prepared/detach.json").read_text()) == {
        "Resources": {}
    }
    assert json.loads((tmp_path / "prepared/parameters.json").read_text()) == [
        {"ParameterKey": "Network", "UsePreviousValue": True}
    ]

    stack["Stacks"][0]["StackStatus"] = "UPDATE_ROLLBACK_FAILED"
    (tmp_path / "stack.json").write_text(json.dumps(stack))
    arguments[-1] = str(tmp_path / "unprepared")
    result = subprocess.run(arguments, check=False, capture_output=True, text=True)
    assert result.returncode != 0
    assert "Recover stack rollback" in result.stderr
    assert not (tmp_path / "unprepared").exists()
