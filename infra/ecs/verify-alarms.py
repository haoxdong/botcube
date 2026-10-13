"""Read-only deployed alarm acceptance; never logs SNS endpoints."""
from __future__ import annotations

import json
import os
import sys
import time
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, TypeVar

import boto3

if TYPE_CHECKING:
    from types_boto3_cloudwatch import CloudWatchClient
    from types_boto3_cloudwatch.literals import StatisticType
    from types_boto3_cloudwatch.type_defs import MetricAlarmTypeDef, MetricOutputTypeDef
    from types_boto3_sns import SNSClient

T = TypeVar('T')
# Namespace, metric name, dimensions, statistic and period of one alarm metric.
MetricSpec = tuple[str, str, dict[str, str], str, int]


def require(condition: object, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def required(value: T | None, name: str) -> T:
    """A provider field that a verdict or its evidence reads; absent, it fails loud (ADR 0030)."""
    if value is None:
        raise RuntimeError(f'AWS response lacks {name}')
    return value


def expected_alarms(outputs: dict[str, str]) -> dict[str, list[tuple[str, str, dict[str, str], StatisticType]]]:
    cluster = outputs['ClusterName']
    service = outputs['ServiceName']
    alb = outputs['LoadBalancerArn'].split(':loadbalancer/')[1]
    target = outputs['TargetGroupArn'].split(':')[-1]
    tasks = {'ClusterName': cluster, 'ServiceName': service}
    return {
        'task-deficit': [('ECS/ContainerInsights', 'RunningTaskCount', tasks, 'Average'),
                         ('ECS/ContainerInsights', 'DesiredTaskCount', tasks, 'Average')],
        'alb-5xx': [('AWS/ApplicationELB', 'HTTPCode_ELB_5XX_Count', {'LoadBalancer': alb}, 'Sum')],
        'target-5xx': [('AWS/ApplicationELB', 'HTTPCode_Target_5XX_Count', {'LoadBalancer': alb, 'TargetGroup': target}, 'Sum')],
        'unhealthy-hosts': [('AWS/ApplicationELB', 'UnHealthyHostCount', {'LoadBalancer': alb, 'TargetGroup': target}, 'Minimum')],
    }


def metric_spec(metric: MetricOutputTypeDef | MetricAlarmTypeDef, statistic: str, period: int) -> MetricSpec:
    dimensions = required(metric.get('Dimensions'), 'metric Dimensions')
    return (required(metric.get('Namespace'), 'metric Namespace'), required(metric.get('MetricName'), 'metric MetricName'),
            {d['Name']: d['Value'] for d in dimensions}, statistic, period)


def task_ratio_metrics(alarm: MetricAlarmTypeDef) -> list[MetricSpec]:
    queries = required(alarm.get('Metrics'), 'alarm Metrics')
    expressions = [q for q in queries if q.get('ReturnData')]
    require(len(expressions) == 1 and expressions[0].get('Expression') == 'running / desired', 'Task ratio expression differs')
    inputs = {q['Id']: q for q in queries if 'MetricStat' in q}
    require(set(inputs) == {'running', 'desired'} and len(queries) == 3, 'Task metric inputs differ')
    actual: list[MetricSpec] = []
    for key in ('running', 'desired'):
        require(inputs[key].get('ReturnData') is False, 'Task input unexpectedly returned')
        stat = required(inputs[key].get('MetricStat'), 'task input MetricStat')
        actual.append(metric_spec(stat['Metric'], stat['Stat'], stat['Period']))
    return actual


def require_alarm_semantics(alarm: MetricAlarmTypeDef, name: str, deficit: bool, topic: str) -> None:
    require(alarm.get('ActionsEnabled') and alarm.get('AlarmActions') == [topic]
            and alarm.get('OKActions') == [topic], f'Alarm actions differ: {name}')
    require(alarm.get('Threshold') == (1 if deficit else 0)
            and alarm.get('ComparisonOperator') == ('LessThanThreshold' if deficit else 'GreaterThanThreshold')
            and alarm.get('EvaluationPeriods') == alarm.get('DatapointsToAlarm') == 3
            and alarm.get('TreatMissingData') == ('breaching' if deficit else 'notBreaching'), f'Alarm semantics differ: {name}')


def verify_configuration(outputs: dict[str, str],
                         alarms: Sequence[MetricAlarmTypeDef]) -> dict[str, list[tuple[str, str, dict[str, str], StatisticType]]]:
    expected = expected_alarms(outputs)
    require(len(alarms) == len(expected), 'Expected all four preview availability alarms')
    for suffix, specs in expected.items():
        name = f"{outputs['ClusterName']}-preview-{suffix}"
        matches = [alarm for alarm in alarms if alarm.get('AlarmName') == name]
        require(len(matches) == 1, f'Missing or duplicate alarm: {name}')
        alarm = matches[0]
        deficit = suffix == 'task-deficit'
        require_alarm_semantics(alarm, name, deficit, outputs['AlertsTopicArn'])
        actual = task_ratio_metrics(alarm) if deficit else [
            metric_spec(alarm, required(alarm.get('Statistic'), 'alarm Statistic'), required(alarm.get('Period'), 'alarm Period'))]
        require(actual == [(*spec, 60) for spec in specs], f'Alarm metric dimensions differ: {name}')
    return expected


def verify_metrics(cw: CloudWatchClient, expected: dict[str, list[tuple[str, str, dict[str, str], StatisticType]]],
                   now: datetime) -> list[dict[str, str | int]]:
    evidence: list[dict[str, str | int]] = []
    for specs in expected.values():
        for namespace, name, dimensions, statistic in specs:
            points = cw.get_metric_statistics(
                Namespace=namespace, MetricName=name,
                Dimensions=[{'Name': key, 'Value': value} for key, value in dimensions.items()],
                StartTime=now - timedelta(minutes=15), EndTime=now, Period=60, Statistics=[statistic])['Datapoints']
            sparse = name.startswith('HTTPCode_')
            evidence.append({'metric': name, 'recentDatapoints': len(points),
                             'emission': 'observed' if points else ('sparse-not-observed' if sparse else 'missing')})
    return evidence


def subscription_summary(sns: SNSClient, topic: str) -> dict[str, int | bool]:
    counts = {'confirmed': 0, 'pendingConfirmation': 0, 'deleted': 0}
    for page in sns.get_paginator('list_subscriptions_by_topic').paginate(TopicArn=topic):
        for subscription in page['Subscriptions']:
            status = required(subscription.get('SubscriptionArn'), 'SNS subscription SubscriptionArn')
            if status == 'PendingConfirmation':
                counts['pendingConfirmation'] += 1
            elif status == 'Deleted':
                counts['deleted'] += 1
            else:
                require(status.startswith('arn:'), 'Unknown SNS subscription status')
                counts['confirmed'] += 1
    return {**counts, 'humanDeliveryVerified': False}


def alarm_states(alarms: Sequence[MetricAlarmTypeDef]) -> dict[str, str]:
    return {required(alarm.get('AlarmName'), 'alarm AlarmName'): required(alarm.get('StateValue'), 'alarm StateValue') for alarm in alarms}


def main():
    outputs = json.loads(Path(sys.argv[1]).read_text())[json.loads((Path(os.environ['CARTRIDGE_DEPLOY_ROOT']) / 'identity.json').read_text())['aws']['ecs']['previewOriginStackName']]
    cw, ecs, sns = boto3.client('cloudwatch'), boto3.client('ecs'), boto3.client('sns')
    cluster = ecs.describe_clusters(clusters=[outputs['ClusterName']], include=['SETTINGS'])
    require(not cluster.get('failures') and len(cluster['clusters']) == 1, 'Preview cluster lookup failed')
    require(any(setting == {'name': 'containerInsights', 'value': 'enabled'} for setting in required(cluster['clusters'][0].get('settings'), 'ECS cluster settings')), 'Container Insights is not enabled')
    names = [f"{outputs['ClusterName']}-preview-{suffix}" for suffix in expected_alarms(outputs)]
    alarms = cw.describe_alarms(AlarmNames=names)['MetricAlarms']
    expected = verify_configuration(outputs, alarms)
    # New Container Insights metrics can take several minutes to appear.
    deadline = time.monotonic() + 600
    while True:
        now = datetime.now(UTC)
        metrics = verify_metrics(cw, expected, now)
        alarms = cw.describe_alarms(AlarmNames=names)['MetricAlarms']
        verify_configuration(outputs, alarms)
        if all(metric['emission'] != 'missing' for metric in metrics) and all(state == 'OK' for state in alarm_states(alarms).values()):
            break
        require(time.monotonic() < deadline, 'Preview metrics missing or availability alarms did not recover to OK within ten minutes')
        time.sleep(30)
    report = {'verifiedAt': now.isoformat(), 'configurationVerified': True,
              'containerInsights': 'enabled', 'metrics': metrics,
              'alarms': [{'name': name, 'state': state} for name, state in alarm_states(alarms).items()],
              'subscriptions': subscription_summary(sns, outputs['AlertsTopicArn']),
              'conditionEvidence': 'Offline synthesized-expression cases; no live outage or notification injection',
              'sourceRevision': os.environ.get('GITHUB_SHA', '')}
    path = Path(os.environ.get('RUNNER_TEMP', '.')) / 'preview-alarms-evidence.json'
    path.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
