import { Duration } from 'aws-cdk-lib';
import type * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * The session API alias's provisioned environments. A page load makes one session API call, and a chat
 * delete's purge holds an environment for ~10 s (p95 11.7 s), so two stay initialized: one user's page
 * load never waits on a cold start (Init Duration p50 8.7 s), even during their own purge. Application
 * Auto Scaling adds environments while more than 70% of them are busy. Five fixed environments ran at
 * 21-27% average use.
 */
export const SESSION_API_PROVISIONED_CONCURRENCY = { min: 2, max: 5, utilization: 0.7 } as const;

/** Scales out within a minute of a burst, and back in only after 15 quiet minutes. */
export function scaleSessionApi(alias: lambda.Alias): void {
  alias
    .addAutoScaling({
      minCapacity: SESSION_API_PROVISIONED_CONCURRENCY.min,
      maxCapacity: SESSION_API_PROVISIONED_CONCURRENCY.max,
    })
    .scaleOnUtilization({
      utilizationTarget: SESSION_API_PROVISIONED_CONCURRENCY.utilization,
      scaleOutCooldown: Duration.minutes(1),
      scaleInCooldown: Duration.minutes(15),
    });
}
