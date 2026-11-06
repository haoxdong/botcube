"""Prepare offline CloudFormation templates for an operator-reviewed Runtime recovery."""

import argparse
import json
import re
from copy import deepcopy
from pathlib import Path
from typing import Any


def templates(
    template: dict[str, Any], outputs: dict[str, str]
) -> dict[str, dict[str, Any]]:
    runtimes = [
        logical
        for logical, resource in template["Resources"].items()
        if resource["Type"] == "AWS::BedrockAgentCore::Runtime"
    ]
    if len(runtimes) != 1:
        raise ValueError(
            "Recovery requires exactly one Runtime in the archived template"
        )
    runtime = runtimes[0]
    name = re.escape(runtime)
    reference = re.compile(rf'"{name}"|\$\{{{name}[.}}]|"{name}\.')
    for logical, resource in template["Resources"].items():
        if logical != runtime and reference.search(json.dumps(resource)):
            raise ValueError(
                f"{logical} references {runtime}; review its recovery manually"
            )

    retained = deepcopy(template)
    retained["Resources"][runtime]["DeletionPolicy"] = "Retain"
    detached = deepcopy(retained)
    del detached["Resources"][runtime]
    for key, output in detached.get("Outputs", {}).items():
        if reference.search(json.dumps(output)):
            if key not in outputs:
                raise ValueError(f"Cannot freeze unresolved Runtime output {key}")
            output["Value"] = outputs[key]
    return {"retain": retained, "detach": detached, "restore": deepcopy(template)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("template", type=Path, help="cloudformation get-template JSON")
    parser.add_argument("stack", type=Path, help="cloudformation describe-stacks JSON")
    parser.add_argument(
        "directory", type=Path, help="new directory for recovery templates"
    )
    args = parser.parse_args()
    template = json.loads(args.template.read_text())["TemplateBody"]
    if isinstance(template, str):
        template = json.loads(template)
    [stack] = json.loads(args.stack.read_text())["Stacks"]
    if stack["StackStatus"] not in {
        "CREATE_COMPLETE",
        "UPDATE_COMPLETE",
        "UPDATE_ROLLBACK_COMPLETE",
    }:
        raise ValueError("Recover stack rollback before preparing Runtime recovery")
    phases = templates(
        template, {row["OutputKey"]: row["OutputValue"] for row in stack["Outputs"]}
    )
    args.directory.mkdir()
    for phase, candidate in phases.items():
        (args.directory / f"{phase}.json").write_text(
            json.dumps(candidate, indent=2) + "\n"
        )
    parameters = [
        {"ParameterKey": parameter["ParameterKey"], "UsePreviousValue": True}
        for parameter in stack.get("Parameters", [])
    ]
    (args.directory / "parameters.json").write_text(
        json.dumps(parameters, indent=2) + "\n"
    )
    print(f"Prepared retain, detach and restore templates for {stack['StackId']}")


if __name__ == "__main__":
    main()
