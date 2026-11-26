"""Backfill EventBridge Scheduler target input for the Scheduled Runs queue."""

import argparse
import json
from typing import Any

import boto3

OCCURRENCE_TIME = '<aws.scheduler.scheduled-time>'


def updated_input(schedule: dict[str, Any], queue_arn: str) -> str | None:
    target = schedule['Target']
    if target['Arn'] != queue_arn:
        return None
    message = json.loads(target['Input'])
    if not isinstance(message, dict) or not all(isinstance(message.get(key), str) and message[key] for key in ('owner', 'taskId')):
        raise ValueError(f"{schedule['GroupName']}/{schedule['Name']} has no BotCube scheduled task identity")
    if message.get('scheduledAt') == OCCURRENCE_TIME:
        return None
    return json.dumps({**message, 'scheduledAt': OCCURRENCE_TIME}, separators=(',', ':'))


def backfill(scheduler: Any, group: str, queue_arn: str, *, apply: bool) -> int:
    fields = scheduler.meta.service_model.operation_model('UpdateSchedule').input_shape.members
    updates = []
    pages = scheduler.get_paginator('list_schedules').paginate(GroupName=group)
    for page in pages:
        for summary in page['Schedules']:
            schedule = scheduler.get_schedule(GroupName=group, Name=summary['Name'])
            if (target_input := updated_input(schedule, queue_arn)) is not None:
                # UpdateSchedule replaces the settings. Keep every writable field returned by GetSchedule.
                request = {key: value for key, value in schedule.items() if key in fields}
                updates.append({**request, 'GroupName': group, 'Target': {**schedule['Target'], 'Input': target_input}})
    if apply:
        for request in updates:
            scheduler.update_schedule(**request)
    return len(updates)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--group', required=True)
    parser.add_argument('--queue-arn', required=True)
    parser.add_argument('--apply', action='store_true', help='Update the schedules. The default lists and counts only.')
    args = parser.parse_args()
    count = backfill(boto3.client('scheduler'), args.group, args.queue_arn, apply=args.apply)
    print(f"{'Updated' if args.apply else 'Would update'} {count} schedule(s) in {args.group}")


if __name__ == '__main__':
    main()
