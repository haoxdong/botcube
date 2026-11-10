import runpy
import sys
from unittest.mock import Mock, patch

import boto3
import pytest

from deploy_script_support import DEPLOY_ECS


@pytest.mark.parametrize('state', ['live', 'parked'])
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
            pytest.raises(SystemExit, match='must be live or parked'):
        runpy.run_path(str(DEPLOY_ECS / 'transition.py'), run_name='__main__')
    ssm.put_parameter.assert_not_called()


def test_service_entrypoint_parses_help_before_cloud_access(capsys: pytest.CaptureFixture[str]) -> None:
    with patch.object(sys, 'argv', ['verify-service.py', '--help']), patch.object(boto3, 'client') as client:
        with pytest.raises(SystemExit) as result:
            runpy.run_path(str(DEPLOY_ECS / 'verify-service.py'), run_name='__main__')
        assert result.value.code == 0
        client.assert_not_called()
    assert '--replacement-evidence' in capsys.readouterr().out


@pytest.mark.parametrize('kind,physical,data', [
    ('Certificate', 'certificate-arn', {'Arn': 'certificate-arn'}),
    ('Dns', 'dns-record', {}),
])
def test_origin_deploy_dispatches_resource_creation(kind: str, physical: str, data: dict[str, str]) -> None:
    sys.path.insert(0, str(DEPLOY_ECS / 'origin-provider'))
    with patch.dict('os.environ', {'ORIGIN_OWNERSHIP': 'bot-cube:preview-origin',
                                   'PARKED_WORKER_NAME': 'bot-cube-parked', 'ORIGIN_ZONE': 'example.com'}):
        import handler

    cloudflare, acm = Mock(), Mock()
    cloudflare.zone.return_value = 'zone'
    cloudflare.put_record.return_value = 'dns-record'
    acm.request_certificate.return_value = {'CertificateArn': 'certificate-arn'}
    event = {'RequestType': 'Create', 'RequestId': 'request',
             'ResourceProperties': {'Kind': kind, 'Hostname': 'api.example.com', 'Target': 'origin.example', 'AlwaysUseHttps': 'on'}}
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
