"""Keep deployed image repositories and keys before removing their CodeBuild owner."""

import copy
import json
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any

from deploy import aws


def retained_template(template: dict[str, Any]) -> dict[str, Any]:
    retained = copy.deepcopy(template)
    resources = retained['Resources']
    repositories = {name: resource for name, resource in resources.items() if resource['Type'] == 'AWS::ECR::Repository'}
    keys = {value['Fn::GetAtt'][0] for resource in repositories.values()
            for value in [resource['Properties'].get('EncryptionConfiguration', {}).get('KmsKey')]
            if isinstance(value, dict) and 'Fn::GetAtt' in value}
    for name, resource in resources.items():
        if name in repositories or name in keys or resource['Type'] == 'Custom::ECRAutoDeleteImages':
            resource.update(DeletionPolicy='Retain', UpdateReplacePolicy='Retain')
    return retained


def review_retention(changes: dict[str, Any]) -> None:
    for change in changes['Changes']:
        resource = change['ResourceChange']
        if resource['Action'] != 'Modify' or resource.get('Replacement') == 'True':
            raise ValueError(f'Image retention would change a resource: {resource}')
        for detail in resource.get('Details', []):
            if detail.get('Evaluation') == 'Dynamic' and detail.get('ChangeSource') in {'ResourceAttribute', 'ResourceReference'}:
                continue
            if detail['Target']['Attribute'] not in {'DeletionPolicy', 'UpdateReplacePolicy'}:
                raise ValueError(f'Image retention would change resource properties: {detail}')
    if changes.get('NextToken'):
        raise ValueError('Incomplete image-retention change set')


def retain_images(stack: str) -> None:
    original = aws('cloudformation', 'get-template', '--stack-name', stack)['TemplateBody']
    if isinstance(original, str):
        original = json.loads(original)
    retained = retained_template(original)
    if retained == original:
        print('Image retention already established')
        return
    state = aws('cloudformation', 'describe-stacks', '--stack-name', stack)['Stacks'][0]
    if state['StackStatus'] not in {'CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'}:
        raise ValueError('Image retention requires a stable stack')
    parameters = [{'ParameterKey': row['ParameterKey'], 'UsePreviousValue': True} for row in state.get('Parameters', [])]
    with tempfile.TemporaryDirectory(prefix='retain-images-') as directory:
        path = Path(directory) / 'template.json'
        path.write_text(json.dumps(retained, separators=(',', ':')))
        created = aws('cloudformation', 'create-change-set', '--stack-name', stack,
                      '--change-set-name', f'image-retention-{uuid.uuid4().hex}',
                      '--template-body', f'file://{path}', '--parameters', json.dumps(parameters),
                      '--capabilities', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND')
    arn = created['Id']
    subprocess.run(['aws', 'cloudformation', 'wait', 'change-set-create-complete', '--stack-name', stack,
                    '--change-set-name', arn], check=True, timeout=600)
    changes = aws('cloudformation', 'describe-change-set', '--stack-name', stack, '--change-set-name', arn)
    review_retention(changes)
    current = aws('cloudformation', 'get-template', '--stack-name', stack)['TemplateBody']
    if isinstance(current, str):
        current = json.loads(current)
    if current != original:
        raise ValueError('Stack changed after the retention change set was prepared')
    aws('cloudformation', 'execute-change-set', '--stack-name', stack, '--change-set-name', arn)
    subprocess.run(['aws', 'cloudformation', 'wait', 'stack-update-complete', '--stack-name', created['StackId']],
                   check=True, timeout=1800)
    actual = aws('cloudformation', 'get-template', '--stack-name', stack)['TemplateBody']
    if isinstance(actual, str):
        actual = json.loads(actual)
    if actual != retained:
        raise ValueError('Deployed image retention differs from the reviewed template')
    print(f'Image retention established with {arn}')


if __name__ == '__main__':
    retain_images(sys.argv[1])
