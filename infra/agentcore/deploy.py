import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

DeployedResources = dict[str, tuple[str, str]]

PROTECTED = {"AWS::BedrockAgentCore::Runtime", "AWS::BedrockAgentCore::Memory"}


def aws(service: str, operation: str, *arguments: str) -> dict[str, Any]:
    result = subprocess.run(
        ["aws", service, operation, *arguments, "--output", "json"],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
        timeout=60,
    )
    return json.loads(result.stdout) if result.stdout.strip() else {}


def identities(stack: str) -> DeployedResources:
    resources = aws("cloudformation", "list-stack-resources", "--stack-name", stack)
    if resources.get("NextToken"):
        raise ValueError("Incomplete stack resource inventory")
    protected = {
        row["LogicalResourceId"]: (row["ResourceType"], row["PhysicalResourceId"])
        for row in resources["StackResourceSummaries"]
        if row["ResourceType"] in PROTECTED
    }
    if sorted(kind for kind, _ in protected.values()) != sorted(PROTECTED):
        raise ValueError("Expected exactly one deployed Runtime and Memory")
    return protected


def review(stack: str, name: str, deployed: DeployedResources) -> tuple[str, bool]:
    change_set = aws(
        "cloudformation",
        "describe-change-set",
        "--stack-name",
        stack,
        "--change-set-name",
        name,
    )
    stack_id = aws("cloudformation", "describe-stacks", "--stack-name", stack)[
        "Stacks"
    ][0]["StackId"]
    if change_set["StackId"] != stack_id:
        raise ValueError("Change set belongs to another stack")
    arn = change_set["ChangeSetId"]
    if not arn.startswith("arn:aws:cloudformation:") or ":changeSet/" not in arn:
        raise ValueError("Missing change-set ARN")
    if change_set.get("NextToken"):
        raise ValueError("Incomplete change set")
    if change_set["Status"] == "FAILED":
        reason = change_set["StatusReason"]
        if (
            "didn't contain changes" in reason
            or "No updates are to be performed" in reason
        ):
            return arn, False
        raise ValueError(f"Change set failed: {reason}")
    if (
        change_set["Status"] != "CREATE_COMPLETE"
        or change_set["ExecutionStatus"] != "AVAILABLE"
    ):
        raise ValueError("Change set is not available")
    changes = change_set["Changes"]
    if not isinstance(changes, list):
        raise ValueError("Missing resource changes")
    for change in changes:
        review_resource(change, deployed)
    return arn, True


def review_resource(change: dict[str, Any], deployed: DeployedResources) -> None:
    if change["Type"] != "Resource":
        raise ValueError("Unknown change type")
    resource = change["ResourceChange"]
    logical = resource["LogicalResourceId"]
    kind = resource["ResourceType"]
    action = resource["Action"]
    if action not in {"Add", "Modify", "Remove", "Import"}:
        raise ValueError("Unknown resource action")
    if kind in PROTECTED or logical in deployed:
        if logical not in deployed or kind != deployed[logical][0]:
            raise ValueError(f"Protected identity changed: {logical}")
        if action != "Modify" or resource.get("Replacement") != "False":
            raise ValueError(f"Protected replacement/deletion rejected: {logical}")
        if resource["PhysicalResourceId"] != deployed[logical][1]:
            raise ValueError(f"Protected physical identity changed: {logical}")


def deploy(stack: str, name: str, commit: str, evidence: str) -> None:
    before = identities(stack)
    arn, changed = review(stack, name, before)
    if changed:
        aws(
            "cloudformation",
            "execute-change-set",
            "--stack-name",
            stack,
            "--change-set-name",
            arn,
        )
        subprocess.run(
            [
                "aws",
                "cloudformation",
                "wait",
                "stack-update-complete",
                "--stack-name",
                stack,
            ],
            check=True,
            timeout=1800,
        )
    after = identities(stack)
    if after != before:
        raise ValueError("Deployed Runtime or Memory identity changed")
    deployed_stack = aws("cloudformation", "describe-stacks", "--stack-name", stack)[
        "Stacks"
    ][0]
    if deployed_stack["StackStatus"] not in {"CREATE_COMPLETE", "UPDATE_COMPLETE"}:
        raise ValueError("Stack is not complete")
    outputs = {
        row["OutputKey"]: row["OutputValue"] for row in deployed_stack["Outputs"]
    }
    if outputs["Commit"] != commit:
        raise ValueError("Deployed Commit does not match checkout")
    version = outputs["AgentRuntimeVersion"]
    runtime = next(
        physical for kind, physical in after.values() if kind.endswith("::Runtime")
    )
    status, runtime_arn = verify_runtime(runtime, version)
    proof = {
        "stack": stack,
        "changeSetArn": arn,
        "executed": changed,
        "commit": commit,
        "runtimeArn": runtime_arn,
        "runtimeVersion": version,
        "status": status,
        "protectedResources": after,
    }
    Path(evidence).write_text(json.dumps(proof, indent=2) + "\n")
    print(json.dumps(proof))


def verify_runtime(runtime_id: str, version: str) -> tuple[str, str]:
    """CloudFormation names a Runtime by its ID, unlike a Memory, by its ARN."""
    deadline = time.monotonic() + 300
    while True:
        state = aws(
            "bedrock-agentcore-control",
            "get-agent-runtime",
            "--agent-runtime-id",
            runtime_id,
            "--agent-runtime-version",
            version,
        )
        if (
            state["agentRuntimeVersion"] != version
            or state["agentRuntimeId"] != runtime_id
        ):
            raise ValueError("Runtime version identity mismatch")
        status = state["status"]
        if status == "READY":
            break
        if status not in {"CREATING", "UPDATING"} or time.monotonic() >= deadline:
            raise ValueError(f"Deployed runtime version is not READY: {status}")
        time.sleep(5)
    verify_endpoint(runtime_id, version)
    return status, state["agentRuntimeArn"]


def verify_endpoint(runtime_id: str, version: str) -> None:
    deadline = time.monotonic() + 300
    while True:
        endpoint = aws(
            "bedrock-agentcore-control",
            "get-agent-runtime-endpoint",
            "--agent-runtime-id",
            runtime_id,
            "--endpoint-name",
            "DEFAULT",
        )
        status = endpoint["status"]
        if status == "READY" and endpoint["liveVersion"] == version:
            return
        if (
            status not in {"CREATING", "UPDATING", "READY"}
            or time.monotonic() >= deadline
        ):
            raise ValueError(
                "DEFAULT endpoint does not serve the deployed READY version"
            )
        time.sleep(5)


if __name__ == "__main__":
    deploy(*sys.argv[1:])
