import io
import json
import runpy
import sys
from pathlib import Path
from unittest.mock import Mock, patch

import boto3
import pytest

from deploy_script_support import DEPLOY_ECS


@pytest.mark.parametrize('state', ['live', 'parked', 'egress', 'credential'])
def test_deploy_workflow_reads_stored_state(state: str, capsys: pytest.CaptureFixture[str]) -> None:
    ssm = Mock()
    ssm.get_parameter.return_value = {'Parameter': {'Value': state}}
    with patch.object(sys, 'argv', ['transition.py', 'state']), patch.object(boto3, 'client', return_value=ssm):
        runpy.run_path(str(DEPLOY_ECS / 'transition.py'), run_name='__main__')
    assert capsys.readouterr().out == state + '\n'
    ssm.get_parameter.assert_called_once()
    ssm.put_parameter.assert_not_called()


def test_deploy_workflow_rejects_invalid_stored_state() -> None:
    ssm = Mock()
    ssm.get_parameter.return_value = {'Parameter': {'Value': 'invalid'}}
    with patch.object(sys, 'argv', ['transition.py', 'state']), \
            patch.object(boto3, 'client', return_value=ssm), \
            pytest.raises(SystemExit, match='must be parked, egress, credential or live'):
        runpy.run_path(str(DEPLOY_ECS / 'transition.py'), run_name='__main__')
    ssm.put_parameter.assert_not_called()


def test_service_entrypoint_parses_help_before_cloud_access(capsys: pytest.CaptureFixture[str]) -> None:
    with patch.object(sys, 'argv', ['verify-service.py', '--help']), patch.object(boto3, 'client') as client:
        with pytest.raises(SystemExit) as result:
            runpy.run_path(str(DEPLOY_ECS / 'verify-service.py'), run_name='__main__')
        assert result.value.code == 0
        client.assert_not_called()
    assert '--replacement-evidence' in capsys.readouterr().out


def test_origin_deploy_reads_the_files_root_from_its_runtime(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    output = tmp_path / 'origin.json'
    monkeypatch.setenv('PREVIEW_ORIGIN_INPUT', str(output))
    monkeypatch.setenv('CLOUDFLARE_ORIGIN_API_TOKEN', 'test-token')
    names = {'originTokenSecretName': 'token', 'originPullClientSecretName': 'client',
             'apiHealthStackName': 'health', 'turnIdentityKeysSecretName': 'keys'}
    arn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/corporate-runtime'
    outputs = [{}, {'VersionId': 'revision'}, {'Parameter': {'Value': arn}},
               {'environmentVariables': {'BOTCUBE_WORKSPACE': '/mnt/corporate/files'}},
               {'VersionIdsToStages': {'keys-revision': ['AWSCURRENT']}}]
    ranges = io.BytesIO(b'{"success": true, "result": {"ipv4_cidrs": ["192.0.2.0/24"]}}')
    with (
        patch('deploy_identity.load_deployment', return_value={'config': {'name': 'corporate'}, 'physicalNames': names}),
        patch('deploy_identity.owned_egress', return_value=None),
        patch('urllib.request.urlopen', return_value=ranges),
        patch('subprocess.run', return_value=Mock(returncode=0)),
        patch('subprocess.check_output', side_effect=[json.dumps(value) for value in outputs]) as aws,
    ):
        runpy.run_path(str(DEPLOY_ECS / 'prepare-origin.py'), run_name='__main__')

    aws.assert_any_call(['aws', 'bedrock-agentcore-control', 'get-agent-runtime',
                         '--agent-runtime-id', 'corporate-runtime', '--output', 'json'])
    prepared = json.loads(output.read_text())
    assert (prepared['runtimeArn'], prepared['filesWorkspace']) == (arn, '/mnt/corporate/files')


@pytest.mark.parametrize('kind,physical,data', [
    ('Certificate', 'certificate-arn', {'Arn': 'certificate-arn'}),
    ('Dns', 'dns-record', {}),
])
def test_origin_deploy_dispatches_resource_creation(kind: str, physical: str, data: dict[str, str]) -> None:
    sys.path.insert(0, str(DEPLOY_ECS / 'origin-provider'))
    with patch.dict('os.environ', {'ORIGIN_OWNERSHIP': 'bot-cube:preview-origin',
                                   'PARKED_WORKER_NAME': 'bot-cube-parked'}):
        import handler

    cloudflare, acm = Mock(), Mock()
    cloudflare.zone.return_value = 'zone'
    cloudflare.put_record.return_value = 'dns-record'
    acm.request_certificate.return_value = {'CertificateArn': 'certificate-arn'}
    event = {'RequestType': 'Create', 'RequestId': 'request',
             'ResourceProperties': {'Kind': kind, 'Hostname': 'api.example.com', 'Target': 'origin.example', 'AlwaysUseHttps': 'on', 'Zone': 'example.com'}}
    with patch.dict(handler.os.environ, {'HOSTNAMES': 'api.example.com'}), \
            patch.object(handler, 'Cloudflare', return_value=cloudflare), \
            patch.object(handler.boto3, 'client', return_value=acm):
        assert handler.on_event(event, None) == {'PhysicalResourceId': physical, 'Data': data}
    if kind == 'Certificate':
        acm.request_certificate.assert_called_once()
        cloudflare.put_record.assert_not_called()
    else:
        cloudflare.put_record.assert_called_once_with('zone', 'api.example.com', 'origin.example', True, None)
        acm.request_certificate.assert_not_called()
