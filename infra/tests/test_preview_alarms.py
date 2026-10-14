"""Alarm acceptance rejects drift and distinguishes telemetry from notification delivery."""
import unittest
from datetime import UTC
from typing import Any
from unittest.mock import Mock

from deploy_script_support import load_deploy_script

alarms = load_deploy_script('preview_alarms', 'verify-alarms.py')

OUTPUTS = {'ClusterName': 'preview', 'ServiceName': 'chat', 'LoadBalancerArn': 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/preview/123',
           'TargetGroupArn': 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/chat/456',
           'AlertsTopicArn': 'arn:aws:sns:us-east-1:123456789012:bot-cube-alerts'}


def configured() -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for suffix, specs in alarms.expected_alarms(OUTPUTS).items():
        deficit = suffix == 'task-deficit'
        alarm = {'AlarmName': f'preview-preview-{suffix}', 'ActionsEnabled': True,
                 'AlarmActions': [OUTPUTS['AlertsTopicArn']], 'OKActions': [OUTPUTS['AlertsTopicArn']],
                 'Threshold': 1 if deficit else 0, 'ComparisonOperator': 'LessThanThreshold' if deficit else 'GreaterThanThreshold',
                 'EvaluationPeriods': 3, 'DatapointsToAlarm': 3, 'TreatMissingData': 'breaching' if deficit else 'notBreaching'}
        metrics = [{'Namespace': ns, 'MetricName': name, 'Dimensions': [{'Name': k, 'Value': v} for k, v in dims.items()]} for ns, name, dims, _ in specs]
        if deficit:
            alarm['Metrics'] = [{'Id': 'expr', 'Expression': 'running / desired', 'ReturnData': True}] + [
                {'Id': key, 'ReturnData': False, 'MetricStat': {'Metric': metric, 'Period': 60, 'Stat': 'Average'}} for key, metric in zip(('running', 'desired'), metrics, strict=True)]
        else:
            alarm.update(metrics[0], Period=60, Statistic=specs[0][3])
        result.append(alarm)
    return result


class PreviewAlarmsTest(unittest.TestCase):
    def test_configured_alarm_set_passes(self):
        self.assertEqual(len(alarms.verify_configuration(OUTPUTS, configured())), 4)

    def test_drift_fails(self):
        changes = [('ActionsEnabled', False), ('AlarmActions', ['arn:wrong']), ('OKActions', []),
                   ('Threshold', 0), ('TreatMissingData', 'notBreaching'), ('EvaluationPeriods', 1)]
        for field, value in changes:
            with self.subTest(field=field):
                values = configured()
                values[0][field] = value
                with self.assertRaises(RuntimeError):
                    alarms.verify_configuration(OUTPUTS, values)
        for mutation in ('namespace', 'dimension', 'expression', 'missing'):
            with self.subTest(mutation=mutation):
                values = configured()
                if mutation == 'namespace':
                    values[0]['Metrics'][1]['MetricStat']['Metric']['Namespace'] = 'AWS/ECS'
                elif mutation == 'dimension':
                    values[0]['Metrics'][1]['MetricStat']['Metric']['Dimensions'] = []
                elif mutation == 'expression':
                    values[0]['Metrics'][0]['Expression'] = 'desired - running'
                else:
                    values.pop()
                with self.assertRaises(RuntimeError):
                    alarms.verify_configuration(OUTPUTS, values)

    def test_absent_continuous_telemetry_fails_but_sparse_errors_are_reported(self):
        cw = Mock()
        cw.get_metric_statistics.return_value = {'Datapoints': []}
        expected = alarms.expected_alarms(OUTPUTS)
        from datetime import datetime
        now = datetime.now(UTC)
        self.assertEqual(alarms.verify_metrics(cw, expected, now)[0]['emission'], 'missing')
        cw.get_metric_statistics.side_effect = lambda **kwargs: {'Datapoints': [] if kwargs['MetricName'].startswith('HTTPCode_') else [{'Average': 1}]}
        evidence = alarms.verify_metrics(cw, expected, now)
        self.assertEqual([item['metric'] for item in evidence if item['emission'] == 'sparse-not-observed'], ['HTTPCode_ELB_5XX_Count', 'HTTPCode_Target_5XX_Count'])
        calls = cw.get_metric_statistics.call_args_list
        self.assertIn({'Name': 'TargetGroup', 'Value': 'targetgroup/chat/456'}, calls[-1].kwargs['Dimensions'])

    def test_subscription_counts_exclude_endpoints_and_never_claim_delivery(self):
        sns = Mock()
        sns.get_paginator.return_value.paginate.return_value = [
            {'Subscriptions': [{'SubscriptionArn': 'PendingConfirmation', 'Endpoint': 'private@example.test'}]},
            {'Subscriptions': [{'SubscriptionArn': 'arn:aws:sns:confirmed'}, {'SubscriptionArn': 'Deleted'}]}]
        self.assertEqual(alarms.subscription_summary(sns, OUTPUTS['AlertsTopicArn']), {
            'confirmed': 1, 'pendingConfirmation': 1, 'deleted': 1, 'humanDeliveryVerified': False})
        sns.get_paginator.return_value.paginate.return_value = [{'Subscriptions': []}]
        self.assertEqual(alarms.subscription_summary(sns, OUTPUTS['AlertsTopicArn'])['confirmed'], 0)


    def test_a_subscription_without_its_arn_fails_loud(self):
        sns = Mock()
        sns.get_paginator.return_value.paginate.return_value = [{'Subscriptions': [{'Endpoint': 'private@example.test'}]}]
        with self.assertRaisesRegex(RuntimeError, 'lacks SNS subscription SubscriptionArn'):
            alarms.subscription_summary(sns, OUTPUTS['AlertsTopicArn'])

    def test_an_alarm_without_its_state_fails_loud(self):
        with self.assertRaisesRegex(RuntimeError, 'lacks alarm StateValue'):
            alarms.alarm_states([{'AlarmName': 'preview-preview-task-deficit'}])

if __name__ == '__main__':
    unittest.main()
