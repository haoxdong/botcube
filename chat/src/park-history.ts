import { paginateGetParameterHistory, SSMClient, type ParameterHistory } from '@aws-sdk/client-ssm';

export interface ParkHistory {
  readonly productName: string;
  parkedAt(time: Date): Promise<boolean>;
}

export function ssmParkHistory(
  parameter: string,
  productName: string,
  // Stryker disable next-line ObjectLiteral: production's client; tests inject one pointed at moto
  ssm = new SSMClient({ region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1' }),
): ParkHistory {
  return {
    productName,
    async parkedAt(time) {
      let latest: ParameterHistory | undefined;
      for await (const { Parameters = [] } of paginateGetParameterHistory({ client: ssm }, { Name: parameter })) {
        for (const version of Parameters) {
          const at = version.LastModifiedDate;
          if (at && at <= time && (!latest?.LastModifiedDate || at >= latest.LastModifiedDate)) latest = version;
        }
      }
      if (latest === undefined) throw new Error(`${parameter} keeps no park state from ${time.toISOString()}`);
      if (!['parked', 'egress', 'credential', 'live'].includes(latest.Value ?? '')) throw new Error(`${parameter} held ${JSON.stringify(latest.Value)}, not a production mode`);
      return latest.Value !== 'live';
    },
  };
}
