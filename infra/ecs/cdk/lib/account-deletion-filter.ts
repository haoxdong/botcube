import { chatAlarmEvents } from 'botcube-config/alarm-events';
import { FilterPattern } from 'aws-cdk-lib/aws-logs';

export const accountDeletionFailureFilter = FilterPattern.anyTerm(
  chatAlarmEvents.accountDeletionFailed,
  chatAlarmEvents.accountPurgeFailed,
);
