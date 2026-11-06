import { GetParameterHistoryCommand, SSMClient, type ParameterHistory } from '@aws-sdk/client-ssm';

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
  const versions = async (): Promise<ParameterHistory[]> => {
    const pages: ParameterHistory[] = [];
    let NextToken: string | undefined;
    do {
      // eslint-disable-next-line no-await-in-loop -- each page names the next
      const page = await ssm.send(new GetParameterHistoryCommand({ Name: parameter, NextToken }));
      pages.push(...(page.Parameters ?? []));
      NextToken = page.NextToken;
    } while (NextToken !== undefined);
    return pages;
  };
  return {
    productName,
    async parkedAt(time) {
      const before = (await versions()).flatMap(({ LastModifiedDate: at, Value: value }) => (at !== undefined && at <= time ? [{ at, value }] : []));
      const latest = before.reduce<(typeof before)[number] | undefined>((last, version) => (last !== undefined && last.at > version.at ? last : version), undefined);
      if (latest === undefined) throw new Error(`${parameter} keeps no park state from ${time.toISOString()}`);
      if (latest.value !== 'parked' && latest.value !== 'live') throw new Error(`${parameter} held ${JSON.stringify(latest.value)}, not live or parked`);
      return latest.value === 'parked';
    },
  };
}
