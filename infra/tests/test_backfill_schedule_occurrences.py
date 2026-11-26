import json
from datetime import UTC, datetime

import boto3
from backfill_schedule_occurrences import backfill
from botocore.stub import Stubber


def test_backfills_only_the_run_queue_and_preserves_the_schedule():
    scheduler = boto3.client('scheduler', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
    group = 'tasks'
    queue = 'arn:aws:sqs:us-east-1:123456789012:runs'
    message = {'owner': 'account', 'taskId': 'task-uuid', 'deliveryFence': 'current'}
    schedule = {
        'Name': 'legacy', 'GroupName': group, 'ScheduleExpression': 'rate(1 day)',
        'ScheduleExpressionTimezone': 'America/New_York', 'State': 'DISABLED',
        'Description': 'Keep the original settings', 'ActionAfterCompletion': 'DELETE',
        'StartDate': datetime(2030, 1, 1, tzinfo=UTC), 'EndDate': datetime(2030, 2, 1, tzinfo=UTC),
        'FlexibleTimeWindow': {'Mode': 'FLEXIBLE', 'MaximumWindowInMinutes': 5},
        'Target': {
            'Arn': queue, 'RoleArn': 'arn:aws:iam::123456789012:role/scheduler',
            'Input': json.dumps(message), 'RetryPolicy': {'MaximumRetryAttempts': 4},
            'DeadLetterConfig': {'Arn': queue + '-failed'},
        },
    }
    updated = {
        **schedule,
        'Target': {**schedule['Target'], 'Input': json.dumps(
            {**message, 'scheduledAt': '<aws.scheduler.scheduled-time>'}, separators=(',', ':'))},
    }
    key = {'Name': 'legacy', 'GroupName': group}
    arn = 'arn:aws:scheduler:us-east-1:123456789012:schedule/tasks/legacy'
    listing = {'Schedules': [{'Name': 'legacy'}], 'NextToken': 'second'}
    another = {**schedule, 'Name': 'other', 'Target': {**schedule['Target'], 'Arn': queue + '-other'}}
    follow = {'Schedules': [{'Name': 'other'}]}
    with Stubber(scheduler) as stub:
        for current, apply in [(schedule, False), (schedule, True), (updated, True)]:
            stub.add_response('list_schedules', listing, {'GroupName': group})
            stub.add_response('get_schedule', {**current, 'Arn': arn}, key)
            stub.add_response('list_schedules', follow, {'GroupName': group, 'NextToken': 'second'})
            stub.add_response('get_schedule', another, {'Name': 'other', 'GroupName': group})
            if apply and current is schedule:
                stub.add_response('update_schedule', {'ScheduleArn': arn}, updated)
        assert backfill(scheduler, group, queue, apply=False) == 1
        assert backfill(scheduler, group, queue, apply=True) == 1
        assert backfill(scheduler, group, queue, apply=True) == 0
        stub.assert_no_pending_responses()
